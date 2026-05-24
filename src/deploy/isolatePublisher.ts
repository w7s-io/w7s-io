import * as BabelStandalone from "@babel/standalone";
import type { DeployArchive } from "./archive";
import { normalizeArchivePath, readTextFile } from "./archive";
import type { Env } from "../env";
import {
  buildCloudflareHeaders,
  optionalCloudflareString,
  parseCloudflareEnvelope,
  requireCloudflareCredentials
} from "./cloudflareApi";
import type { WorkerUploadBinding } from "./workerBindings";

type BabelStandaloneApi = {
  transform: (
    code: string,
    options?: Record<string, unknown>
  ) => {
    code?: string | null;
  };
};

type UploadedModule = {
  name: string;
  content: string;
  contentType: string;
};

export type IsolatePublishResult = {
  namespace: string;
  scriptName: string;
  entrypoint: string;
  compatibilityDate: string;
  startupTimeMs: number | null;
};

const DEFAULT_DISPATCH_NAMESPACE = "w7s-isolate";
const DEFAULT_COMPATIBILITY_DATE = "2026-05-23";
const NATIVE_APP_ROOTS = ["worker", "backend"] as const;
const ENTRYPOINT_CANDIDATES = [
  "worker/index.ts",
  "worker/index.mts",
  "worker/index.js",
  "worker/index.mjs",
  "backend/index.ts",
  "backend/index.mts",
  "backend/index.js",
  "backend/index.mjs"
];

const babelStandalone =
  (BabelStandalone as unknown as { default?: BabelStandaloneApi }).default ??
  (BabelStandalone as unknown as BabelStandaloneApi);

const dirname = (value: string) => {
  const normalized = normalizeArchivePath(value);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "" : normalized.slice(0, index);
};

const joinPath = (baseDir: string, target: string) => {
  const stack = normalizeArchivePath(baseDir).split("/").filter(Boolean);
  normalizeArchivePath(target)
    .split("/")
    .filter(Boolean)
    .forEach((part) => {
      if (part === ".") return;
      if (part === "..") {
        stack.pop();
        return;
      }
      stack.push(part);
    });
  return stack.join("/");
};

const isJavaScriptModulePath = (path: string) => /\.(js|mjs|ts|mts)$/i.test(path);
const isTypeScriptModulePath = (path: string) => /\.(ts|mts)$/i.test(path);

export const detectWorkerEntrypoint = (archive: DeployArchive) =>
  ENTRYPOINT_CANDIDATES.find((path) => archive.files.has(path)) ?? null;

const resolveNativeAppRoot = (path: string) => {
  const normalized = normalizeArchivePath(path);
  const root = NATIVE_APP_ROOTS.find((candidate) => normalized.startsWith(`${candidate}/`));
  if (!root) {
    throw new Error(`Native module ${path} must be inside worker/ or backend/.`);
  }
  return root;
};

const toCloudflareModuleName = (path: string) => {
  const normalized = normalizeArchivePath(path);
  const root = resolveNativeAppRoot(normalized);
  const relative = normalized.slice(`${root}/`.length);
  if (!relative) {
    throw new Error(`Native module ${path} resolved to an empty upload name.`);
  }
  return relative;
};

const extractStaticModuleRequests = (code: string) => {
  const requests = new Set<string>();
  const patterns = [
    /\bimport\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bexport\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null = null;
    while ((match = pattern.exec(code))) {
      const request = match[1]?.trim();
      if (request) requests.add(request);
    }
  }
  return [...requests];
};

const resolveRelativeModulePath = (
  fromPath: string,
  request: string,
  archive: DeployArchive
) => {
  const nativeRoot = resolveNativeAppRoot(fromPath);
  if (!request.startsWith("./") && !request.startsWith("../") && !request.startsWith("/")) {
    throw new Error(
      `Native deploy currently supports only relative imports inside ${nativeRoot}/. Unsupported import: ${request}`
    );
  }
  const basePath = request.startsWith("/")
    ? normalizeArchivePath(request)
    : joinPath(dirname(fromPath), request);
  const candidates = [
    basePath,
    `${basePath}.js`,
    `${basePath}.mjs`,
    `${basePath}.ts`,
    `${basePath}.mts`,
    `${basePath}/index.js`,
    `${basePath}/index.mjs`,
    `${basePath}/index.ts`,
    `${basePath}/index.mts`
  ];
  for (const candidate of candidates) {
    if (!candidate.startsWith(`${nativeRoot}/`)) continue;
    if (archive.files.has(candidate) && isJavaScriptModulePath(candidate)) return candidate;
  }
  throw new Error(`Could not resolve ${request} from ${fromPath}.`);
};

const transpileTypeScriptModule = (source: string, path: string) => {
  const transformed = babelStandalone.transform(source, {
    filename: path,
    presets: [["typescript", { allowDeclareFields: true, onlyRemoveTypeImports: false }]],
    parserOpts: {
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      plugins: ["typescript", "dynamicImport", "importAttributes", "topLevelAwait"]
    },
    sourceMaps: false,
    comments: true,
    compact: false
  });
  const output = typeof transformed.code === "string" ? transformed.code.trim() : "";
  if (!output) throw new Error(`TypeScript transpilation produced empty output for ${path}.`);
  return output;
};

export const buildIsolateUploadModules = (entrypoint: string, archive: DeployArchive) => {
  const modules = new Map<string, UploadedModule>();
  const queue = [entrypoint];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const currentPath = queue.shift();
    if (!currentPath || visited.has(currentPath)) continue;
    visited.add(currentPath);

    const source = readTextFile(archive, currentPath);
    if (!source?.trim()) {
      throw new Error(`Worker module ${currentPath} was not found in the deploy archive.`);
    }

    const output = isTypeScriptModulePath(currentPath)
      ? transpileTypeScriptModule(source, currentPath)
      : source;
    const requests = new Set([
      ...extractStaticModuleRequests(source),
      ...extractStaticModuleRequests(output)
    ]);
    for (const request of requests) {
      const resolved = resolveRelativeModulePath(currentPath, request, archive);
      if (!visited.has(resolved)) queue.push(resolved);
    }

    modules.set(currentPath, {
      name: toCloudflareModuleName(currentPath),
      content: output,
      contentType: "application/javascript+module"
    });
  }

  return [...modules.values()];
};

const ensureDispatchNamespace = async (params: {
  apiToken: string;
  accountId: string;
  namespace: string;
}) => {
  const namespaceUrl = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(params.accountId)}/workers/dispatch/namespaces/${encodeURIComponent(params.namespace)}`;
  const getResponse = await fetch(namespaceUrl, {
    headers: buildCloudflareHeaders(params.apiToken)
  });
  if (getResponse.ok) {
    await parseCloudflareEnvelope(getResponse);
    return;
  }
  if (getResponse.status !== 404) {
    await parseCloudflareEnvelope(getResponse);
    return;
  }

  const createResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(params.accountId)}/workers/dispatch/namespaces`,
    {
      method: "POST",
      headers: {
        ...buildCloudflareHeaders(params.apiToken),
        "content-type": "application/json"
      },
      body: JSON.stringify({ name: params.namespace })
    }
  );
  await parseCloudflareEnvelope(createResponse);
};

export const publishIsolateWorker = async (params: {
  env: Env;
  archive: DeployArchive;
  scriptName: string;
  entrypoint: string;
  bindings?: WorkerUploadBinding[];
}): Promise<IsolatePublishResult> => {
  const { apiToken, accountId } = requireCloudflareCredentials(params.env);
  const namespace =
    optionalCloudflareString(params.env.CLOUDFLARE_DISPATCH_NAMESPACE) ?? DEFAULT_DISPATCH_NAMESPACE;
  const compatibilityDate =
    optionalCloudflareString(params.env.CLOUDFLARE_ISOLATE_COMPATIBILITY_DATE) ??
    DEFAULT_COMPATIBILITY_DATE;
  const entrypoint = normalizeArchivePath(params.entrypoint);
  if (!ENTRYPOINT_CANDIDATES.includes(entrypoint)) {
    throw new Error("Native deploy requires worker/index.js, worker/index.mjs, worker/index.ts, worker/index.mts, backend/index.js, backend/index.mjs, backend/index.ts, or backend/index.mts.");
  }
  const modules = buildIsolateUploadModules(entrypoint, params.archive);

  await ensureDispatchNamespace({
    apiToken,
    accountId,
    namespace
  });

  const metadata = {
    main_module: toCloudflareModuleName(entrypoint),
    compatibility_date: compatibilityDate,
    ...(params.bindings && params.bindings.length > 0 ? { bindings: params.bindings } : {})
  };
  const formData = new FormData();
  formData.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
  for (const module of modules) {
    const uploadFileName = module.name.split("/").pop() ?? "index.js";
    formData.append(
      module.name,
      new File([module.content], uploadFileName, { type: module.contentType })
    );
  }

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/dispatch/namespaces/${encodeURIComponent(namespace)}/scripts/${encodeURIComponent(params.scriptName)}`,
    {
      method: "PUT",
      headers: buildCloudflareHeaders(apiToken),
      body: formData
    }
  );
  const result = await parseCloudflareEnvelope<{ startup_time_ms?: number }>(response);

  return {
    namespace,
    scriptName: params.scriptName,
    entrypoint,
    compatibilityDate,
    startupTimeMs: typeof result?.startup_time_ms === "number" ? result.startup_time_ms : null
  };
};
