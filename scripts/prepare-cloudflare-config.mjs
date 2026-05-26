import { mkdir, writeFile } from "node:fs/promises";

const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || process.env.ACCOUNT_ID?.trim();
const zoneName = process.env.W7S_ZONE_NAME?.trim() || "w7s.cloud";
const deploymentsKvName = process.env.W7S_DEPLOYMENTS_KV_NAME?.trim() || "w7s-io-deployments";
const staticBucketName = process.env.W7S_STATIC_ASSETS_BUCKET?.trim() || "w7s-io-static-assets";
const dispatchNamespace = process.env.W7S_DISPATCH_NAMESPACE?.trim() || "w7s-isolate";
const analyticsDataset = process.env.W7S_ANALYTICS_DATASET?.trim() || "";
const workflowName = process.env.W7S_WORKFLOW_NAME?.trim() || "w7s-workflows";
const userWorkerCpuMs = process.env.W7S_USER_WORKER_CPU_MS?.trim() || "50";
const userWorkerSubrequests = process.env.W7S_USER_WORKER_SUBREQUESTS?.trim() || "25";
const scheduleCron = process.env.W7S_CORE_CRON?.trim() || "* * * * *";
const attachWildcardRoute = /^(1|true|yes|on)$/i.test(
  process.env.W7S_ATTACH_WILDCARD_ROUTE?.trim() || ""
);
const compatibilityDate =
  process.env.W7S_COMPATIBILITY_DATE?.trim() ||
  process.env.CLOUDFLARE_ISOLATE_COMPATIBILITY_DATE?.trim() ||
  "2026-05-23";
const appCommitId = process.env.GITHUB_SHA?.trim() || null;
const appDeployBranch =
  process.env.W7S_DEPLOY_BRANCH?.trim() ||
  process.env.GITHUB_REF_NAME?.trim() ||
  null;
const appDeployedAt = process.env.W7S_DEPLOYED_AT?.trim() || null;
const workerName = "w7s-io";

if (!apiToken) {
  throw new Error("CLOUDFLARE_API_TOKEN is required.");
}

if (!accountId) {
  throw new Error("CLOUDFLARE_ACCOUNT_ID or ACCOUNT_ID is required.");
}

const cfRequest = async (method, path, body) => {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiToken}`,
      ...(body ? { "content-type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (response.ok && parsed?.success !== false) return parsed?.result ?? null;
  const message =
    parsed?.errors?.map((entry) => entry?.message).filter(Boolean).join("; ") ||
    text ||
    `Cloudflare API request failed with ${response.status}`;
  const error = new Error(message);
  error.status = response.status;
  throw error;
};

const ensureKvNamespace = async (title) => {
  const result = await cfRequest(
    "GET",
    `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces?per_page=100`
  );
  const namespaces = Array.isArray(result) ? result : [];
  const existing = namespaces.find((entry) => entry?.title === title);
  if (existing?.id) return existing.id;

  const created = await cfRequest(
    "POST",
    `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces`,
    { title }
  );
  if (!created?.id) throw new Error(`Cloudflare did not return an id for KV namespace ${title}.`);
  return created.id;
};

const ensureR2Bucket = async (name) => {
  const result = await cfRequest(
    "GET",
    `/accounts/${encodeURIComponent(accountId)}/r2/buckets?per_page=100`
  );
  const buckets = Array.isArray(result?.buckets)
    ? result.buckets
    : Array.isArray(result)
      ? result
      : [];
  if (buckets.some((entry) => entry?.name === name)) return;

  try {
    await cfRequest("POST", `/accounts/${encodeURIComponent(accountId)}/r2/buckets`, { name });
  } catch (error) {
    if (error?.status === 409) return;
    throw error;
  }
};

const ensureDispatchNamespace = async (name) => {
  const encodedAccount = encodeURIComponent(accountId);
  const encodedName = encodeURIComponent(name);
  try {
    await cfRequest("GET", `/accounts/${encodedAccount}/workers/dispatch/namespaces/${encodedName}`);
    return;
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
  await cfRequest("POST", `/accounts/${encodedAccount}/workers/dispatch/namespaces`, { name });
};

const resolveZoneId = async (name) => {
  const result = await cfRequest(
    "GET",
    `/zones?name=${encodeURIComponent(name)}&per_page=50`
  );
  const zones = Array.isArray(result) ? result : [];
  const exact = zones.find((entry) => entry?.name === name);
  if (!exact?.id) {
    throw new Error(`Unable to find Cloudflare zone id for ${name}.`);
  }
  return exact.id;
};

const [kvNamespaceId, zoneId] = await Promise.all([
  ensureKvNamespace(deploymentsKvName),
  resolveZoneId(zoneName),
  ensureR2Bucket(staticBucketName),
  ensureDispatchNamespace(dispatchNamespace)
]);

const config = {
  $schema: "node_modules/wrangler/config-schema.json",
  name: workerName,
  main: "src/worker.ts",
  compatibility_date: compatibilityDate,
  workers_dev: true,
  triggers: {
    crons: [scheduleCron]
  },
  workflows: [
    {
      name: workflowName,
      binding: "W7S_WORKFLOWS",
      class_name: "W7SWorkflow"
    }
  ],
  vars: {
    W7S_BASE_DOMAIN: zoneName,
    W7S_WORKER_NAME: workerName,
    CLOUDFLARE_DISPATCH_NAMESPACE: dispatchNamespace,
    CLOUDFLARE_ISOLATE_COMPATIBILITY_DATE: compatibilityDate,
    W7S_USER_WORKER_CPU_MS: userWorkerCpuMs,
    W7S_USER_WORKER_SUBREQUESTS: userWorkerSubrequests,
    ...(appCommitId ? { APP_COMMIT_ID: appCommitId } : {}),
    ...(appDeployBranch ? { APP_DEPLOY_BRANCH: appDeployBranch } : {}),
    ...(appDeployedAt ? { APP_DEPLOYED_AT: appDeployedAt } : {})
  },
  dispatch_namespaces: [
    {
      binding: "DISPATCHER",
      namespace: dispatchNamespace,
      remote: true
    }
  ],
  kv_namespaces: [
    {
      binding: "DEPLOYMENTS_KV",
      id: kvNamespaceId,
      preview_id: kvNamespaceId
    }
  ],
  r2_buckets: [
    {
      binding: "STATIC_ASSETS",
      bucket_name: staticBucketName,
      preview_bucket_name: staticBucketName
    }
  ],
  ...(analyticsDataset
    ? {
        analytics_engine_datasets: [
          {
            binding: "W7S_ANALYTICS",
            dataset: analyticsDataset
          }
        ]
      }
    : {})
};

await mkdir(".wrangler", { recursive: true });
await writeFile("wrangler.generated.jsonc", `${JSON.stringify(config, null, 2)}\n`);
await writeFile(
  ".wrangler/secrets.json",
  `${JSON.stringify(
    {
      CLOUDFLARE_API_TOKEN: apiToken,
      CLOUDFLARE_ACCOUNT_ID: accountId
    },
    null,
    2
  )}\n`
);

console.log(
  JSON.stringify(
    {
      generated: "wrangler.generated.jsonc",
      secretsFile: ".wrangler/secrets.json",
      zoneName,
      zoneId,
      deploymentsKvName,
      deploymentsKvId: kvNamespaceId,
      staticBucketName,
      dispatchNamespace,
      analyticsDataset: analyticsDataset || null,
      workflowName,
      userWorkerCpuMs,
      userWorkerSubrequests,
      scheduleCron,
      attachWildcardRoute,
      routeManagement: "post-deploy"
    },
    null,
    2
  )
);
