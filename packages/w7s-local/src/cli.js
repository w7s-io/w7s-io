import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const DEFAULT_PORT = 8787;
const DEFAULT_BASE_DOMAIN = "local.w7s.cloud";
const DEFAULT_COMPATIBILITY_DATE = "2025-09-24";
const STATIC_ROOTS = [
  "frontend/dist",
  "frontend/build",
  "frontend/out",
  "dist/client",
  "dist",
  "build",
  "out"
];

const usage = `w7s-local

Usage:
  w7s-local [options]

Options:
  --root <dir>             App root. Defaults to cwd.
  --owner <slug>           GitHub owner/org slug. Inferred from git remote when possible.
  --repo <slug>            GitHub repo slug. Inferred from package.json or cwd.
  --environment <name>     W7S environment. Defaults to production.
  --base-domain <domain>   Local W7S base domain. Defaults to local.w7s.cloud.
  --port <port>            Local workerd HTTP port. Defaults to 8787.
  --frontend <dir>         Static output directory. Auto-detected by W7S conventions.
  --backend <url>          Backend/dev server origin to proxy after stripping the repo prefix.
  --command <command>      Start a dev command before serving.
  --workerd <path>         workerd executable. Defaults to the bundled npm dependency.
  --help                   Show this help.

Examples:
  w7s-local --backend http://localhost:5173
  w7s-local --owner acme --repo app --frontend dist
  w7s-local --command "npm run dev -- --host 127.0.0.1 --port 5173" --backend http://localhost:5173
`;

const WORKER_SOURCE = `
const RESERVED_ORG_LABELS = new Set(["www", "api", "app"]);
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm"
};

const normalizeSlug = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 100);

const normalizeEnvironment = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63) || "production";

const cleanHost = (value) => String(value || "").trim().toLowerCase().replace(/:\\d+$/, "");

const resolveRuntimeHost = (host, baseDomain, project) => {
  if (!host.endsWith("." + baseDomain)) {
    return {
      orgSlug: project.owner,
      environments: [project.environment, "production"],
      localFallback: true
    };
  }

  const suffixLength = ("." + baseDomain).length;
  const label = host.slice(0, -1 * suffixLength);
  if (!label || RESERVED_ORG_LABELS.has(label)) return null;

  const branchSeparator = label.lastIndexOf("--");
  if (branchSeparator > 0) {
    const environment = normalizeEnvironment(label.slice(0, branchSeparator));
    const orgSlug = normalizeSlug(label.slice(branchSeparator + 2));
    if (!orgSlug || RESERVED_ORG_LABELS.has(orgSlug)) return null;
    return { orgSlug, environments: [environment, "production"] };
  }

  for (const prefix of ["dev", "staging", "preview"]) {
    const marker = prefix + "-";
    if (label.startsWith(marker)) {
      const orgSlug = normalizeSlug(label.slice(marker.length));
      return orgSlug ? { orgSlug, environments: [prefix, "production"] } : null;
    }
  }

  const orgSlug = normalizeSlug(label);
  return orgSlug ? { orgSlug, environments: ["production"] } : null;
};

const splitRepoPath = (path) => {
  const segments = path.split("/").map((segment) => segment.trim()).filter(Boolean);
  const repoSlug = normalizeSlug(segments[0] || "");
  if (!repoSlug) return null;
  const trailingSlash = path.endsWith("/") ? "/" : "";
  return {
    repoSlug,
    repoPath: segments.length > 1 ? "/" + segments.slice(1).join("/") + trailingSlash : "/"
  };
};

const routeCandidates = (path, orgSlug) => {
  const candidates = [];
  const repoInfo = splitRepoPath(path);
  if (repoInfo) candidates.push({ ...repoInfo, mount: "repo-prefix" });
  if (!repoInfo || repoInfo.repoSlug !== orgSlug) {
    candidates.push({ repoSlug: orgSlug, repoPath: path || "/", mount: "org-root" });
  }
  return candidates;
};

const extname = (path) => {
  const name = path.split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
};

const contentTypeFor = (path) => CONTENT_TYPES[extname(path)] || "application/octet-stream";

const safeStaticPath = (repoPath) => {
  try {
    const decoded = decodeURIComponent(repoPath.split(/[?#]/, 1)[0] || "/").replace(/\\\\/g, "/");
    const parts = decoded.split("/").filter(Boolean);
    if (parts.some((part) => part === "." || part === "..")) return null;
    return parts.join("/");
  } catch {
    return null;
  }
};

const appendStaticCandidate = (candidates, value) => {
  if (!candidates.includes(value)) candidates.push(value);
};

const staticCandidates = (repoPath) => {
  const path = safeStaticPath(repoPath);
  if (path === null) return [];
  const candidates = [];
  if (!path || repoPath.endsWith("/")) {
    appendStaticCandidate(candidates, path ? path + "/index.html" : "index.html");
    return candidates;
  }
  appendStaticCandidate(candidates, path);
  appendStaticCandidate(candidates, path + "/index.html");
  return candidates;
};

const diskUrlFor = (path) => {
  const url = new URL("http://static/");
  url.pathname = "/" + path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return url;
};

const isDirectoryListing = (response) => {
  const contentType = response.headers.get("content-type") || "";
  return contentType.includes("application/json") && !response.headers.has("content-length");
};

const fetchStaticFile = async (env, request, path) => {
  const response = await env.STATIC.fetch(new Request(diskUrlFor(path), { method: request.method }));
  if (!response.ok || isDirectoryListing(response)) return null;
  const headers = new Headers(response.headers);
  headers.set("content-type", contentTypeFor(path));
  headers.set("cache-control", path.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable");
  headers.set("x-w7s-local", "static");
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};

const maybeStaticResponse = async (request, env, repoPath, mode) => {
  if (!env.STATIC || (request.method !== "GET" && request.method !== "HEAD")) return null;
  if (mode === "fallback") return fetchStaticFile(env, request, "index.html");
  for (const candidate of staticCandidates(repoPath)) {
    const response = await fetchStaticFile(env, request, candidate);
    if (response) return response;
  }
  return null;
};

const joinUrlPath = (prefix, repoPath) => {
  const cleanPrefix = String(prefix || "").replace(/\\/+$/g, "");
  const cleanPath = String(repoPath || "/").replace(/^\\/+/, "");
  return (cleanPrefix + "/" + cleanPath).replace(/\\/+/g, "/") || "/";
};

const proxyBackend = async (request, env, repoPath, route, originalPath) => {
  if (!env.BACKEND) return null;
  const incoming = new URL(request.url);
  const target = new URL("http://w7s-local-backend");
  target.pathname = joinUrlPath(env.CONFIG.backendPathPrefix, repoPath);
  target.search = incoming.search;

  const headers = new Headers(request.headers);
  for (const key of ["host", "connection", "content-length", "transfer-encoding"]) {
    headers.delete(key);
  }
  headers.set("x-w7s-org-slug", route.orgSlug);
  headers.set("x-w7s-repo-slug", route.repoSlug);
  headers.set("x-w7s-original-path", originalPath);

  const init = {
    method: request.method,
    headers,
    redirect: "manual"
  };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;

  const response = await env.BACKEND.fetch(new Request(target, init));
  const output = new Response(response.body, response);
  output.headers.set("x-w7s-local", "backend");
  return output;
};

const localStatus = (env) =>
  new Response(
    JSON.stringify(
      {
        status: "ok",
        service: "w7s-local",
        runtime: "workerd",
        repository: env.CONFIG.owner + "/" + env.CONFIG.repo,
        environment: env.CONFIG.environment,
        staticRoot: env.CONFIG.staticRoot,
        backend: env.CONFIG.backend
      },
      null,
      2
    ),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    }
  );

const notFound = (message) =>
  new Response(message, {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    }
  });

const handleRequest = async (request, env) => {
  const requestUrl = new URL(request.url);
  if (requestUrl.pathname === "/_w7s/local/status") return localStatus(env);

  const project = {
    owner: env.CONFIG.owner,
    repo: env.CONFIG.repo,
    environment: env.CONFIG.environment
  };
  const host = resolveRuntimeHost(cleanHost(request.headers.get("host") || ""), cleanHost(env.CONFIG.baseDomain), project);
  if (!host) return notFound("Host is not routable by w7s-local.");

  const candidates = routeCandidates(requestUrl.pathname, host.orgSlug);
  for (const candidate of candidates) {
    const isProjectRepo =
      candidate.mount === "repo-prefix"
        ? candidate.repoSlug === project.repo
        : project.repo === project.owner && candidate.repoSlug === project.owner;
    const environmentMatches = host.localFallback || host.environments.includes(project.environment);
    if (!isProjectRepo || !environmentMatches) continue;

    if (
      candidate.mount === "repo-prefix" &&
      env.STATIC &&
      (request.method === "GET" || request.method === "HEAD") &&
      candidate.repoPath === "/" &&
      !requestUrl.pathname.endsWith("/")
    ) {
      requestUrl.pathname = requestUrl.pathname + "/";
      return new Response(null, {
        status: 302,
        headers: {
          location: requestUrl.toString(),
          "cache-control": "no-store"
        }
      });
    }

    const exactStatic = await maybeStaticResponse(request, env, candidate.repoPath, "exact");
    if (exactStatic) return exactStatic;

    const backendResponse = await proxyBackend(
      request,
      env,
      candidate.repoPath,
      { orgSlug: host.orgSlug, repoSlug: candidate.repoSlug },
      requestUrl.pathname
    );
    if (backendResponse && !(["GET", "HEAD"].includes(request.method) && [404, 405].includes(backendResponse.status))) {
      return backendResponse;
    }

    const fallbackStatic = await maybeStaticResponse(request, env, candidate.repoPath, "fallback");
    if (fallbackStatic) return fallbackStatic;
    if (backendResponse) return backendResponse;
  }

  return notFound("Nothing is deployed locally for " + project.owner + "/" + project.repo + ".");
};

export default {
  async fetch(request, env) {
    try {
      const response = await handleRequest(request, env);
      const headers = new Headers(response.headers);
      headers.set("x-w7s-local-runtime", "workerd");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    } catch (error) {
      console.error(error);
      return new Response(error instanceof Error ? error.message : "w7s-local failed.", {
        status: 500,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "x-w7s-local-runtime": "workerd"
        }
      });
    }
  }
};
`;

const normalizeSlug = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 100);

const normalizeEnvironment = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63) || "production";

const parseArgs = (args) => {
  const options = {
    root: process.cwd(),
    baseDomain: process.env.W7S_LOCAL_BASE_DOMAIN || DEFAULT_BASE_DOMAIN,
    port: Number(process.env.PORT || process.env.W7S_LOCAL_PORT || DEFAULT_PORT),
    environment: process.env.W7S_ENVIRONMENT || "production",
    workerd: process.env.WORKERD || process.env.WORKERD_PATH || ""
  };
  const requireValue = (name, index) => {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--root") {
      options.root = requireValue(arg, index);
      index += 1;
    } else if (arg === "--owner") {
      options.owner = requireValue(arg, index);
      index += 1;
    } else if (arg === "--repo") {
      options.repo = requireValue(arg, index);
      index += 1;
    } else if (arg === "--environment" || arg === "--env") {
      options.environment = requireValue(arg, index);
      index += 1;
    } else if (arg === "--base-domain") {
      options.baseDomain = requireValue(arg, index);
      index += 1;
    } else if (arg === "--port") {
      options.port = Number(requireValue(arg, index));
      index += 1;
    } else if (arg === "--frontend") {
      options.frontend = requireValue(arg, index);
      index += 1;
    } else if (arg === "--backend") {
      options.backend = requireValue(arg, index).replace(/\/+$/g, "");
      index += 1;
    } else if (arg === "--command") {
      options.command = requireValue(arg, index);
      index += 1;
    } else if (arg === "--workerd") {
      options.workerd = requireValue(arg, index);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage}`);
    }
  }

  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535.");
  }
  return options;
};

const directoryExists = (path) => {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const readJsonFile = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
};

const inferRepositoryFromGit = async (root) => {
  const gitConfigPath = join(root, ".git", "config");
  let text = "";
  try {
    text = await readFile(gitConfigPath, "utf8");
  } catch {
    return null;
  }
  const match = text.match(/url\s*=\s*(?:git@github\.com:|https:\/\/github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\s*$/m);
  if (!match) return null;
  return {
    owner: normalizeSlug(match[1]),
    repo: normalizeSlug(match[2])
  };
};

const inferProject = async (root, options) => {
  const packageJson = await readJsonFile(join(root, "package.json"));
  const gitRepo = await inferRepositoryFromGit(root);
  const packageScope = packageJson?.name?.startsWith("@")
    ? normalizeSlug(packageJson.name.split("/")[0].slice(1))
    : "";
  const repoFromPackage = normalizeSlug(
    packageJson?.name?.startsWith("@")
      ? packageJson.name.split("/")[1]
      : packageJson?.name
  );
  const repo = normalizeSlug(options.repo) || gitRepo?.repo || repoFromPackage || normalizeSlug(basename(root));
  const owner = normalizeSlug(options.owner) || gitRepo?.owner || packageScope || normalizeSlug(process.env.USER) || "local";
  return {
    owner,
    repo,
    environment: normalizeEnvironment(options.environment)
  };
};

const resolveStaticRoot = (root, frontend) => {
  if (frontend) {
    const candidate = resolve(root, frontend);
    if (!directoryExists(candidate)) {
      throw new Error(`Static directory does not exist: ${candidate}`);
    }
    return candidate;
  }
  for (const candidate of STATIC_ROOTS) {
    const path = join(root, candidate);
    if (directoryExists(path)) return path;
  }
  return null;
};

const normalizeExecutablePath = (value) => {
  if (!value) return "";
  if (value.startsWith(".") || value.startsWith("/") || value.includes("\\") || value.includes("/")) {
    return resolve(value);
  }
  return value;
};

const resolveWorkerdBinary = (value) => {
  const explicit = normalizeExecutablePath(value);
  if (explicit) return explicit;
  try {
    return require.resolve("workerd/bin/workerd");
  } catch {
    return process.platform === "win32" ? "workerd.cmd" : "workerd";
  }
};

const shellCommand = () => process.platform === "win32" ? "cmd.exe" : "sh";
const shellArgs = (command) => process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];

const spawnDevCommand = (command, root) => {
  if (!command) return null;
  const child = spawn(shellCommand(), shellArgs(command), {
    cwd: root,
    stdio: "inherit",
    env: process.env
  });
  child.on("exit", (code, signal) => {
    if (signal) console.error(`w7s-local dev command exited with signal ${signal}.`);
    else if (code && code !== 0) console.error(`w7s-local dev command exited with code ${code}.`);
  });
  return child;
};

const closeChild = (child) => {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
};

const capnpText = (value) => JSON.stringify(String(value));

const capnpJson = (value) => JSON.stringify(JSON.stringify(value));

const parseBackend = (value) => {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--backend must be an http:// or https:// URL.");
  }
  const hostname = url.hostname;
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return {
    url: url.toString().replace(/\/+$/g, ""),
    address: `${host}:${port}`,
    protocol: url.protocol,
    hostname,
    pathPrefix: url.pathname === "/" ? "" : url.pathname.replace(/\/+$/g, "")
  };
};

const renderExternalServer = (backend) => {
  if (backend.protocol === "http:") {
    return `external = (address = ${capnpText(backend.address)}, http = ())`;
  }
  return [
    `external = (`,
    `  address = ${capnpText(backend.address)},`,
    `  https = (`,
    `    options = (),`,
    `    tlsOptions = (trustBrowserCas = true),`,
    `    certificateHost = ${capnpText(backend.hostname)}`,
    `  )`,
    `)`
  ].join("\n");
};

const renderWorkerdConfig = ({ project, baseDomain, port, staticRoot, backend }) => {
  const config = {
    owner: project.owner,
    repo: project.repo,
    environment: project.environment,
    baseDomain,
    staticRoot,
    backend: backend?.url ?? null,
    backendPathPrefix: backend?.pathPrefix ?? ""
  };
  const bindings = [
    `(name = "CONFIG", json = ${capnpJson(config)})`
  ];
  if (staticRoot) bindings.push(`(name = "STATIC", service = "static")`);
  if (backend) bindings.push(`(name = "BACKEND", service = "backend")`);

  const services = [
    [
      `(name = "main", worker = (`,
      `  modules = [(name = "worker.js", esModule = embed "worker.js")],`,
      `  compatibilityDate = ${capnpText(DEFAULT_COMPATIBILITY_DATE)},`,
      `  bindings = [${bindings.join(", ")}]`,
      `))`
    ].join("\n")
  ];

  if (staticRoot) {
    services.push(`(name = "static", disk = (path = ${capnpText(staticRoot)}, writable = false, allowDotfiles = false))`);
  }
  if (backend) {
    services.push(`(name = "backend", ${renderExternalServer(backend)})`);
  }

  return [
    `using Workerd = import "/workerd/workerd.capnp";`,
    ``,
    `const config :Workerd.Config = (`,
    `  services = [`,
    services.map((service) => `    ${service.replace(/\n/g, "\n    ")}`).join(",\n"),
    `  ],`,
    `  sockets = [`,
    `    (name = "http", address = ${capnpText(`127.0.0.1:${port}`)}, http = (), service = "main")`,
    `  ]`,
    `);`
  ].join("\n");
};

const writeWorkerdProject = async ({ project, baseDomain, port, staticRoot, backend }) => {
  const tempDir = await mkdtemp(join(tmpdir(), "w7s-local-"));
  const workerPath = join(tempDir, "worker.js");
  const configPath = join(tempDir, "config.capnp");
  await writeFile(workerPath, WORKER_SOURCE, "utf8");
  await writeFile(
    configPath,
    renderWorkerdConfig({
      project,
      baseDomain,
      port,
      staticRoot,
      backend
    }),
    "utf8"
  );
  return { tempDir, workerPath, configPath };
};

const waitForChild = (child) =>
  new Promise((resolveWait, rejectWait) => {
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      rejectWait(error);
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      if (signal) resolveWait(0);
      else resolveWait(code ?? 0);
    });
  });

export const main = async (args) => {
  const options = parseArgs(args);
  if (options.help) {
    console.log(usage);
    return;
  }

  const root = resolve(options.root);
  const project = await inferProject(root, options);
  const staticRoot = resolveStaticRoot(root, options.frontend);
  const backend = parseBackend(options.backend);
  if (!staticRoot && !backend) {
    throw new Error("No local target found. Provide --backend <url>, --frontend <dir>, or build static output first.");
  }

  const devChild = spawnDevCommand(options.command, root);
  let shutdownRequested = false;
  let workerdChild = null;
  let tempDir = "";

  const prodHost =
    project.environment === "production"
      ? `${project.owner}.${options.baseDomain}`
      : `${project.environment}--${project.owner}.${options.baseDomain}`;
  const localUrl =
    project.repo === project.owner
      ? `http://${prodHost}:${options.port}/`
      : `http://${prodHost}:${options.port}/${project.repo}/`;

  try {
    const workerdProject = await writeWorkerdProject({
      project,
      baseDomain: options.baseDomain,
      port: options.port,
      staticRoot,
      backend
    });
    tempDir = workerdProject.tempDir;
    const workerd = resolveWorkerdBinary(options.workerd);

    console.log(`w7s-local serving ${project.owner}/${project.repo} (${project.environment}) with workerd`);
    console.log(`local router: http://127.0.0.1:${options.port}`);
    console.log(`w7s URL:      ${localUrl}`);
    console.log(`workerd:      ${workerd}`);
    console.log(`config:       ${workerdProject.configPath}`);
    if (staticRoot) console.log(`static:       ${staticRoot}`);
    if (backend) console.log(`backend:      ${backend.url}`);

    workerdChild = spawn(workerd, ["serve", workerdProject.configPath, "config"], {
      cwd: tempDir,
      stdio: "inherit",
      env: process.env
    });

    const shutdown = () => {
      shutdownRequested = true;
      closeChild(workerdChild);
      closeChild(devChild);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    const exitCode = await waitForChild(workerdChild);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    if (!shutdownRequested && exitCode !== 0) process.exitCode = exitCode;
  } finally {
    closeChild(devChild);
    if (tempDir && !process.env.W7S_LOCAL_KEEP_TEMP) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
