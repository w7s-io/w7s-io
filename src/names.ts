const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,99})$/i;

export const normalizeSlug = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9._-]+$/g, "");

export const requireSlug = (value: string, field: string) => {
  const slug = normalizeSlug(value);
  if (!slug || !SLUG_PATTERN.test(slug)) {
    throw new Error(`Invalid ${field}.`);
  }
  return slug;
};

export const branchToEnvironment = (branch: string) => {
  const normalized = normalizeSlug(branch);
  if (!normalized || normalized === "main" || normalized === "master") {
    return "production";
  }
  return normalized;
};

export const resolveEnvironment = (params: {
  branch: string;
  queryValue?: string | null;
  headerValue?: string | null;
}) => {
  const override = (params.queryValue ?? params.headerValue ?? "").trim();
  if (override) return requireSlug(override, "environment");
  return branchToEnvironment(params.branch);
};

export const sanitizeScriptPart = (value: string) =>
  normalizeSlug(value).replace(/[._]+/g, "-") || "worker";

export const buildStableScriptName = (orgSlug: string, repoSlug: string, environment: string) =>
  `${sanitizeScriptPart(orgSlug)}--${sanitizeScriptPart(repoSlug)}--${sanitizeScriptPart(environment)}`;

