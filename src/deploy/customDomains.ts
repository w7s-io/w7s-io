import type { DeployArchive } from "./archive";
import { readTextFile } from "./archive";
import type { Env } from "../env";
import { normalizeSlug } from "../names";
import { loadCustomDomainMapping } from "../storage/deployments";

const CNAME_PATHS = [
  "CNAME",
  "frontend/CNAME",
  "frontend/dist/CNAME",
  "dist/client/CNAME",
  "dist/CNAME",
  "build/CNAME",
  "out/CNAME"
];
const DEFAULT_WORKER_NAME = "w7s-io";
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;
const TXT_TOKEN_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]{0,99})(?:\/[a-z0-9](?:[a-z0-9._-]{0,99}))?$/;

export type CustomDomainWarning = {
  hostname: string;
  domain: string;
  txtName: string;
  txtValue: string;
  currentRepository?: string;
  message: string;
};

export type BlockedCustomDomain = {
  hostname: string;
  domain: string;
  reason: "txt_allowlist_mismatch";
  txtName: string;
  txtValue: string;
  currentRepository?: string;
  message: string;
};

export type CustomDomainPlan = {
  attached: string[];
  warnings: CustomDomainWarning[];
  blocked: BlockedCustomDomain[];
};

const normalizeHostname = (value: string) => {
  let candidate = value.trim().toLowerCase();
  if (!candidate) return null;
  if (/^https?:\/\//i.test(candidate)) {
    candidate = new URL(candidate).hostname;
  }
  candidate = candidate.replace(/\.$/, "");
  if (!HOSTNAME_PATTERN.test(candidate)) {
    throw new Error(`Invalid custom domain in CNAME file: ${value}`);
  }
  return candidate;
};

export const readCustomDomains = (archive: DeployArchive) => {
  const hostnames = new Set<string>();
  for (const path of CNAME_PATHS) {
    const text = readTextFile(archive, path);
    if (!text) continue;
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    for (const line of lines) {
      const hostname = normalizeHostname(line);
      if (hostname) hostnames.add(hostname);
    }
  }
  return [...hostnames];
};

const cfRequest = async (env: Env, method: string, path: string, body?: unknown) => {
  if (!env.CLOUDFLARE_API_TOKEN) {
    throw new Error("CLOUDFLARE_API_TOKEN is required to attach custom domains.");
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let parsed: { success?: boolean; result?: unknown; errors?: Array<{ message?: string }> } | null = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {}
  if (response.ok && parsed?.success !== false) return parsed?.result;
  const message =
    parsed?.errors?.map((entry) => entry?.message).filter(Boolean).join("; ") ||
    text ||
    `Cloudflare API request failed with ${response.status}`;
  const error = new Error(message);
  (error as Error & { status?: number }).status = response.status;
  throw error;
};

type Zone = {
  id?: string;
  name?: string;
};

type WorkerRoute = {
  id?: string;
  pattern?: string;
  script?: string | null;
  script_name?: string | null;
  scriptName?: string | null;
};

const findZoneForHostname = async (env: Env, hostname: string) => {
  const result = await cfRequest(env, "GET", "/zones?per_page=100");
  const zones = Array.isArray(result) ? (result as Zone[]) : [];
  const matches = zones
    .filter((zone) => zone.id && zone.name && (hostname === zone.name || hostname.endsWith(`.${zone.name}`)))
    .sort((a, b) => (b.name?.length ?? 0) - (a.name?.length ?? 0));
  const zone = matches[0];
  if (!zone?.id || !zone.name) {
    throw new Error(`Unable to find a Cloudflare zone for custom domain ${hostname}.`);
  }
  return { id: zone.id, name: zone.name };
};

const routeScriptName = (route: WorkerRoute) =>
  route.script || route.script_name || route.scriptName || null;

const verificationTxtName = (domain: string) => `_w7s.${domain}`;
const repoTxtValue = (orgSlug: string, repoSlug: string) => `${orgSlug}/${repoSlug}`;

const decodeDnsTxtData = (data: string) => {
  const chunks = [...data.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) =>
    (match[1] ?? "").replace(/\\(\d{3}|.)/g, (_all, escaped: string) =>
      /^\d{3}$/.test(escaped) ? String.fromCharCode(Number(escaped)) : escaped
    )
  );
  return chunks.length > 0 ? chunks.join("") : data.trim();
};

const parseTxtAllowlist = (values: string[]) =>
  [
    ...new Set(
      values
        .flatMap((value) => decodeDnsTxtData(value).split(","))
        .map((token) => token.trim().toLowerCase())
        .filter((token) => TXT_TOKEN_PATTERN.test(token))
    )
  ];

type DnsJsonAnswer = {
  type?: number;
  data?: string;
};

const lookupTxtAllowlist = async (txtName: string) => {
  try {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(txtName)}&type=TXT`;
    const response = await fetch(url, {
      headers: {
        accept: "application/dns-json"
      }
    });
    if (!response.ok) return { hasTxt: false, allowlist: [] as string[] };
    const payload = await response.json() as { Answer?: DnsJsonAnswer[] };
    const values = (payload.Answer ?? [])
      .filter((answer) => answer.type === 16 && typeof answer.data === "string")
      .map((answer) => answer.data as string);
    return {
      hasTxt: values.length > 0,
      allowlist: parseTxtAllowlist(values)
    };
  } catch {
    return { hasTxt: false, allowlist: [] as string[] };
  }
};

const isAuthorizedByAllowlist = (params: {
  allowlist: string[];
  orgSlug: string;
  repoSlug: string;
}) => {
  const repoEntry = repoTxtValue(params.orgSlug, params.repoSlug);
  return params.allowlist.includes(params.orgSlug) || params.allowlist.includes(repoEntry);
};

export const planCustomDomainClaims = async (params: {
  env: Env;
  hostnames: string[];
  orgSlug: string;
  repoSlug: string;
}) => {
  const plan: CustomDomainPlan = {
    attached: [],
    warnings: [],
    blocked: []
  };
  const orgSlug = normalizeSlug(params.orgSlug);
  const repoSlug = normalizeSlug(params.repoSlug);

  for (const hostname of params.hostnames) {
    const zone = await findZoneForHostname(params.env, hostname);
    const txtName = verificationTxtName(zone.name);
    const txtValue = repoTxtValue(orgSlug, repoSlug);
    const existing = await loadCustomDomainMapping(params.env, hostname);
    const sameRepo = existing?.orgSlug === orgSlug && existing.repoSlug === repoSlug;
    const txt = await lookupTxtAllowlist(txtName);

    if (txt.hasTxt) {
      if (isAuthorizedByAllowlist({ allowlist: txt.allowlist, orgSlug, repoSlug })) {
        plan.attached.push(hostname);
        continue;
      }
      plan.blocked.push({
        hostname,
        domain: zone.name,
        reason: "txt_allowlist_mismatch",
        txtName,
        txtValue,
        ...(existing?.repository ? { currentRepository: existing.repository } : {}),
        message: `TXT ${txtName} does not authorize ${txtValue}.`
      });
      continue;
    }

    plan.attached.push(hostname);
    plan.warnings.push({
      hostname,
      domain: zone.name,
      txtName,
      txtValue,
      ...(existing && !sameRepo ? { currentRepository: existing.repository } : {}),
      message:
        existing && !sameRepo
          ? `${hostname} replaced the unverified custom-domain claim by ${existing.repository}. Add TXT ${txtName}=${txtValue} to restrict future claims for this domain.`
          : `Add TXT ${txtName}=${txtValue} to restrict future claims for this domain.`
    });
  }

  return plan;
};

export const attachCustomDomainRoutes = async (env: Env, hostnames: string[]) => {
  const workerName = env.W7S_WORKER_NAME?.trim() || DEFAULT_WORKER_NAME;
  const attached: Array<{ hostname: string; pattern: string; zoneId: string; zoneName: string }> = [];

  for (const hostname of hostnames) {
    const zone = await findZoneForHostname(env, hostname);
    const pattern = `${hostname}/*`;
    const routesResult = await cfRequest(
      env,
      "GET",
      `/zones/${encodeURIComponent(zone.id)}/workers/routes?per_page=100`
    );
    const routes = Array.isArray(routesResult) ? (routesResult as WorkerRoute[]) : [];
    const existing = routes.find((route) => route.pattern === pattern);
    const existingScript = existing ? routeScriptName(existing) : null;

    if (existing?.id && existingScript && existingScript !== workerName) {
      await cfRequest(
        env,
        "DELETE",
        `/zones/${encodeURIComponent(zone.id)}/workers/routes/${encodeURIComponent(existing.id)}`
      );
    }

    if (!existing || existingScript !== workerName) {
      await cfRequest(
        env,
        "POST",
        `/zones/${encodeURIComponent(zone.id)}/workers/routes`,
        {
          pattern,
          script: workerName
        }
      );
    }

    attached.push({
      hostname,
      pattern,
      zoneId: zone.id,
      zoneName: zone.name
    });
  }

  return attached;
};
