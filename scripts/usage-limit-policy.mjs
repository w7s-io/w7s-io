import { readFile } from "node:fs/promises";

const DEFAULT_NAMESPACE_NAME = "w7s-io-deployments";
const DEFAULT_LIMITS = [
  ["deploy", 50, 0.8],
  ["runtime.request", 10_000, 0.8],
  ["worker.request", 10_000, 0.8],
  ["runtime.cpu_ms", 300_000, 0.8],
  ["worker.script", 5, 0.8],
  ["static.r2_class_a", 1_000, 0.8],
  ["static.r2_class_b", 20_000, 0.8],
  ["r2.class_a", 1_000, 0.8],
  ["r2.class_b", 20_000, 0.8],
  ["r2.storage_bytes", 100 * 1024 * 1024, 0.8],
  ["kv.read", 10_000, 0.8],
  ["kv.write", 1_000, 0.8],
  ["kv.delete", 1_000, 0.8],
  ["kv.list", 1_000, 0.8],
  ["kv.storage_bytes", 50 * 1024 * 1024, 0.8],
  ["d1.rows_read", 100_000, 0.8],
  ["d1.rows_written", 10_000, 0.8],
  ["d1.read_queries", 10_000, 0.8],
  ["d1.write_queries", 1_000, 0.8],
  ["d1.storage_bytes", 50 * 1024 * 1024, 0.8],
  ["durable_object.request", 5_000, 0.8],
  ["durable_object.duration_ms", 300_000, 0.8],
  ["durable_object.rows_read", 100_000, 0.8],
  ["durable_object.rows_written", 10_000, 0.8],
  ["durable_object.storage_read_units", 100_000, 0.8],
  ["durable_object.storage_write_units", 10_000, 0.8],
  ["durable_object.storage_deletes", 10_000, 0.8],
  ["rpc.dispatch", 10_000, 0.8],
  ["queue.send", 10_000, 0.8],
  ["queue.delivery", 10_000, 0.8],
  ["schedule.delivery", 2_000, 0.8],
  ["workflow.create", 1_000, 0.8],
  ["workflow.delivery", 1_000, 0.8],
  ["log.write", 5_000, 0.8]
];
const KNOWN_METRICS = new Set(DEFAULT_LIMITS.map(([metric]) => metric));
const SCOPES = new Set([
  "owner",
  "owner_environment",
  "repo",
  "repo_environment",
  "owner_total",
  "owner_total_environment",
  "global",
  "global_environment"
]);

const usage = `Usage:
  npm run limits:get -- --owner <owner> --repo <repo> [--environment production]
  npm run limits:get -- --scope <scope> --owner <owner> [--repo <repo>] [--environment production]
  npm run limits:set -- --scope <scope> --owner <owner> [--repo <repo>] [--environment production] --metric <metric> [--daily-units 5000] [--warning-threshold 0.7]
  npm run limits:delete -- --scope <scope> --owner <owner> [--repo <repo>] [--environment production] [--metric <metric>]

Scopes:
  owner
  owner_environment
  repo
  repo_environment
  owner_total
  owner_total_environment
  global
  global_environment

Metrics:
  ${[...KNOWN_METRICS].join(", ")}`;

const parseArgs = (argv) => {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith("--")) {
      args._.push(entry);
      continue;
    }
    const name = entry.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[name] = true;
      continue;
    }
    args[name] = next;
    index += 1;
  }
  return args;
};

const printJson = (value) => {
  console.log(JSON.stringify(value, null, 2));
};

const fail = (message) => {
  console.error(message);
  console.error("");
  console.error(usage);
  process.exit(1);
};

const normalizeSlug = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9._-]+$/g, "");

const sanitizeScriptPart = (value) =>
  normalizeSlug(value).replace(/[._]+/g, "-") || "worker";

const requiredSlug = (args, name) => {
  const value = normalizeSlug(args[name]);
  if (!value) fail(`Missing or invalid --${name}.`);
  return value;
};

const optionalEnvironment = (args) => sanitizeScriptPart(args.environment || "production");

const positiveInteger = (value, name) => {
  if (value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) fail(`--${name} must be a positive number.`);
  return Math.floor(number);
};

const threshold = (value) => {
  if (value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1) {
    fail("--warning-threshold must be greater than 0 and less than or equal to 1.");
  }
  return number;
};

const usageLimitPolicyKey = (params) => {
  const org = sanitizeScriptPart(params.owner);
  const repo = params.repo ? sanitizeScriptPart(params.repo) : null;
  const environment = params.environment ? sanitizeScriptPart(params.environment) : null;
  if (params.scope === "owner") return `usage_limit_policy:v1:owner:${org}`;
  if (params.scope === "owner_environment") {
    return `usage_limit_policy:v1:owner_environment:${environment}:${org}`;
  }
  if (params.scope === "owner_total") return `usage_limit_policy:v1:owner_total:${org}`;
  if (params.scope === "owner_total_environment") {
    return `usage_limit_policy:v1:owner_total_environment:${environment}:${org}`;
  }
  if (params.scope === "global") return "usage_limit_policy:v1:global";
  if (params.scope === "global_environment") return `usage_limit_policy:v1:global_environment:${environment}`;
  if (params.scope === "repo") return `usage_limit_policy:v1:repo:${org}:${repo}`;
  return `usage_limit_policy:v1:repo_environment:${environment}:${org}:${repo}`;
};

const validateScopeTarget = (args) => {
  const scope = String(args.scope || "").trim();
  if (!SCOPES.has(scope)) fail("Missing or invalid --scope.");
  const owner = scope.startsWith("global") ? "global" : requiredSlug(args, "owner");
  const repo = scope.startsWith("repo") ? requiredSlug(args, "repo") : normalizeSlug(args.repo || "");
  const environment = scope.endsWith("_environment") ? optionalEnvironment(args) : normalizeSlug(args.environment || "");
  return { scope, owner, repo, environment };
};

const metricName = (args) => {
  const metric = String(args.metric || "").trim().toLowerCase();
  if (!KNOWN_METRICS.has(metric)) fail("Missing or invalid --metric.");
  return metric;
};

const readLocalSecrets = async () => {
  try {
    const raw = await readFile(".wrangler/secrets.json", "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

const loadConfig = async () => {
  const secrets = await readLocalSecrets();
  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim() || secrets.CLOUDFLARE_API_TOKEN?.trim();
  const accountId =
    process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ||
    process.env.ACCOUNT_ID?.trim() ||
    secrets.CLOUDFLARE_ACCOUNT_ID?.trim();
  const namespaceName = process.env.W7S_DEPLOYMENTS_KV_NAME?.trim() || DEFAULT_NAMESPACE_NAME;
  const namespaceId = process.env.W7S_DEPLOYMENTS_KV_ID?.trim() || "";
  if (!apiToken) fail("CLOUDFLARE_API_TOKEN is required, or .wrangler/secrets.json must exist.");
  if (!accountId) fail("CLOUDFLARE_ACCOUNT_ID or ACCOUNT_ID is required, or .wrangler/secrets.json must exist.");
  return { apiToken, accountId, namespaceName, namespaceId };
};

const createCloudflareClient = async () => {
  const config = await loadConfig();
  const cfRequest = async (method, path, body, contentType = "application/json") => {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        ...(body !== undefined ? { "content-type": contentType } : {})
      },
      ...(body !== undefined ? { body } : {})
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (response.ok && parsed?.success !== false) return parsed?.result ?? parsed ?? null;
    const message =
      parsed?.errors?.map((entry) => entry?.message).filter(Boolean).join("; ") ||
      text ||
      `Cloudflare API request failed with ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  };

  const resolveNamespaceId = async () => {
    if (config.namespaceId) return config.namespaceId;
    const result = await cfRequest(
      "GET",
      `/accounts/${encodeURIComponent(config.accountId)}/storage/kv/namespaces?per_page=100`
    );
    const namespaces = Array.isArray(result) ? result : [];
    const namespace = namespaces.find((entry) => entry?.title === config.namespaceName);
    if (!namespace?.id) fail(`Unable to find KV namespace ${config.namespaceName}.`);
    return namespace.id;
  };

  const namespaceId = await resolveNamespaceId();
  const kvPath = (key) =>
    `/accounts/${encodeURIComponent(config.accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/values/${encodeURIComponent(key)}`;

  return {
    config: { ...config, namespaceId },
    async read(key) {
      try {
        const response = await fetch(`https://api.cloudflare.com/client/v4${kvPath(key)}`, {
          headers: { authorization: `Bearer ${config.apiToken}` }
        });
        if (response.status === 404) return null;
        const text = await response.text();
        if (!response.ok) throw new Error(text || `Cloudflare API request failed with ${response.status}`);
        if (!text) return null;
        return JSON.parse(text);
      } catch (error) {
        if (error?.status === 404) return null;
        throw error;
      }
    },
    async write(key, value) {
      await cfRequest("PUT", kvPath(key), JSON.stringify(value, null, 2), "application/json");
    },
    async delete(key) {
      await cfRequest("DELETE", kvPath(key));
    }
  };
};

const normalizeRecord = (record) =>
  record && record.version === 1 && record.metrics && typeof record.metrics === "object"
    ? record
    : { version: 1, metrics: {} };

const knownRecordMetrics = (record) =>
  Object.fromEntries(
    Object.entries(record?.metrics || {}).filter(([metric]) => KNOWN_METRICS.has(metric))
  );

const defaultPolicy = () =>
  Object.fromEntries(
    DEFAULT_LIMITS.map(([metric, dailyUnits, warningThreshold]) => [
      metric,
      { metric, dailyUnits, warningThreshold, source: "default" }
    ])
  );

const applyRecord = (policy, record, source) => {
  for (const [metric, value] of Object.entries(knownRecordMetrics(record))) {
    const current = policy[metric];
    if (!current) continue;
    const patch = typeof value === "number" ? { dailyUnits: value } : value;
    if (!patch || typeof patch !== "object") continue;
    const dailyUnits = positiveInteger(patch.dailyUnits, "daily-units");
    const warningThreshold = threshold(patch.warningThreshold);
    policy[metric] = {
      ...current,
      ...(dailyUnits !== null ? { dailyUnits } : {}),
      ...(warningThreshold !== null ? { warningThreshold } : {}),
      source
    };
  }
};

const getEffective = async (client, args) => {
  const owner = requiredSlug(args, "owner");
  const repo = requiredSlug(args, "repo");
  const environment = optionalEnvironment(args);
  const lookups = [];
  const policy = defaultPolicy();
  for (const scope of ["owner", "owner_environment", "repo", "repo_environment"]) {
    const key = usageLimitPolicyKey({ scope, owner, repo, environment });
    const record = await client.read(key);
    lookups.push({
      scope,
      key,
      found: !!record,
      metrics: Object.keys(knownRecordMetrics(record))
    });
    if (record) applyRecord(policy, record, scope);
  }
  return {
    version: 1,
    period: "daily",
    mode: "enforce",
    environment,
    owner,
    repo,
    policy,
    lookups
  };
};

const commandGet = async (client, args) => {
  if (args.scope) {
    const target = validateScopeTarget(args);
    const key = usageLimitPolicyKey(target);
    const record = await client.read(key);
    printJson({ key, record });
    return;
  }
  printJson(await getEffective(client, args));
};

const commandSet = async (client, args) => {
  const target = validateScopeTarget(args);
  const metric = metricName(args);
  const dailyUnits = positiveInteger(args["daily-units"], "daily-units");
  const warningThreshold = threshold(args["warning-threshold"]);
  if (dailyUnits === null && warningThreshold === null) {
    fail("Set requires --daily-units, --warning-threshold, or both.");
  }

  const key = usageLimitPolicyKey(target);
  const record = normalizeRecord(await client.read(key));
  const existing = typeof record.metrics[metric] === "number"
    ? { dailyUnits: record.metrics[metric] }
    : record.metrics[metric] || {};
  record.metrics[metric] = {
    ...existing,
    ...(dailyUnits !== null ? { dailyUnits } : {}),
    ...(warningThreshold !== null ? { warningThreshold } : {})
  };
  record.updatedAt = new Date().toISOString();
  await client.write(key, record);
  printJson({ action: "set", key, record });
};

const commandDelete = async (client, args) => {
  const target = validateScopeTarget(args);
  const key = usageLimitPolicyKey(target);
  if (args.metric) {
    const metric = metricName(args);
    const record = normalizeRecord(await client.read(key));
    delete record.metrics[metric];
    const remaining = Object.keys(record.metrics);
    if (remaining.length === 0) {
      await client.delete(key);
      printJson({ action: "delete", key, deleted: true });
      return;
    }
    record.updatedAt = new Date().toISOString();
    await client.write(key, record);
    printJson({ action: "delete_metric", key, metric, record });
    return;
  }
  await client.delete(key);
  printJson({ action: "delete", key, deleted: true });
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || rest.includes("--help")) {
    console.log(usage);
    return;
  }
  const args = parseArgs(rest);
  if (!["get", "set", "delete"].includes(command)) fail(`Unknown command: ${command}`);
  const client = await createCloudflareClient();
  if (command === "get") return commandGet(client, args);
  if (command === "set") return commandSet(client, args);
  if (command === "delete") return commandDelete(client, args);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
