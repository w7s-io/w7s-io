import type { DeployArchive } from "./archive";
import { readTextFile } from "./archive";
import type { Env } from "../env";

const CNAME_PATHS = ["frontend/CNAME", "frontend/dist/CNAME"];
const DEFAULT_WORKER_NAME = "w7s-io";
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;

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
    const first = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("#"));
    if (!first) continue;
    const hostname = normalizeHostname(first);
    if (hostname) hostnames.add(hostname);
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
