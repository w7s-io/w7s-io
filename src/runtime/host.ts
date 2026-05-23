import { normalizeSlug } from "../names";

const DEFAULT_BASE_DOMAIN = "w7s.cloud";
const RESERVED_ORG_LABELS = new Set(["www", "api", "app"]);

export type RuntimeHost = {
  orgSlug: string;
  environments: string[];
};

export const cleanHost = (value: string) => value.trim().toLowerCase().replace(/:\d+$/, "");

export const getBaseDomain = (env: { W7S_BASE_DOMAIN?: string }) =>
  cleanHost(env.W7S_BASE_DOMAIN || DEFAULT_BASE_DOMAIN);

export const resolveRuntimeHost = (
  request: Request,
  env: { W7S_BASE_DOMAIN?: string }
): RuntimeHost | null => {
  const url = new URL(request.url);
  const host = cleanHost(request.headers.get("host") || url.host);
  const baseDomain = getBaseDomain(env);
  if (!host.endsWith(`.${baseDomain}`)) return null;
  const label = host.slice(0, -1 * (`.${baseDomain}`).length);
  if (!label || RESERVED_ORG_LABELS.has(label)) return null;

  const environmentPrefixes = ["dev", "staging", "preview"];
  for (const prefix of environmentPrefixes) {
    const marker = `${prefix}-`;
    if (label.startsWith(marker)) {
      const orgSlug = normalizeSlug(label.slice(marker.length));
      if (!orgSlug) return null;
      return {
        orgSlug,
        environments: [prefix, "production"]
      };
    }
  }

  const orgSlug = normalizeSlug(label);
  if (!orgSlug) return null;
  return {
    orgSlug,
    environments: ["production"]
  };
};
