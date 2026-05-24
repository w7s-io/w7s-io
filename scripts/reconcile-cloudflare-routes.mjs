const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || process.env.ACCOUNT_ID?.trim();
const zoneName = process.env.W7S_ZONE_NAME?.trim() || "w7s.cloud";
const deploymentsKvName = process.env.W7S_DEPLOYMENTS_KV_NAME?.trim() || "w7s-io-deployments";
const attachWildcardRoute = /^(1|true|yes|on)$/i.test(
  process.env.W7S_ATTACH_WILDCARD_ROUTE?.trim() || ""
);
const workerName = "w7s-io";
const customDomainPrefix = "custom_domain:v1:";

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

const listZones = async () => {
  const result = await cfRequest("GET", "/zones?per_page=100");
  return Array.isArray(result) ? result.filter((zone) => zone?.id && zone?.name) : [];
};

const resolveZoneForHostname = (zones, hostname) =>
  zones
    .filter((zone) => hostname === zone.name || hostname.endsWith(`.${zone.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0] ?? null;

const routeScriptName = (route) =>
  route?.script || route?.script_name || route?.scriptName || null;

const ensureWorkerRoute = async ({ zoneId, pattern }) => {
  const result = await cfRequest(
    "GET",
    `/zones/${encodeURIComponent(zoneId)}/workers/routes?per_page=100`
  );
  const routes = Array.isArray(result) ? result : [];
  const existing = routes.find((route) => route?.pattern === pattern);
  const existingScript = existing ? routeScriptName(existing) : null;

  if (existing?.id && existingScript !== workerName) {
    console.log(`Replacing ${pattern}: ${existingScript} -> ${workerName}`);
    await cfRequest(
      "DELETE",
      `/zones/${encodeURIComponent(zoneId)}/workers/routes/${encodeURIComponent(existing.id)}`
    );
  }

  if (!existing || existingScript !== workerName) {
    console.log(`Attaching ${pattern} -> ${workerName}`);
    try {
      await cfRequest(
        "POST",
        `/zones/${encodeURIComponent(zoneId)}/workers/routes`,
        {
          pattern,
          script: workerName
        }
      );
    } catch (error) {
      if (/already exists|conflict|duplicate|10020/i.test(error?.message ?? "")) {
        console.warn(`Route ${pattern} already exists; leaving it in place.`);
        return;
      }
      throw error;
    }
  }
};

const findKvNamespaceId = async () => {
  const result = await cfRequest(
    "GET",
    `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces?per_page=100`
  );
  const namespaces = Array.isArray(result) ? result : [];
  const namespace = namespaces.find((entry) => entry?.title === deploymentsKvName);
  if (!namespace?.id) {
    throw new Error(`Unable to find KV namespace ${deploymentsKvName}.`);
  }
  return namespace.id;
};

const listCustomDomainHostnames = async (namespaceId) => {
  const hostnames = new Set();
  let cursor = null;

  do {
    const query = new URLSearchParams({
      prefix: customDomainPrefix,
      limit: "1000"
    });
    if (cursor) query.set("cursor", cursor);
    const result = await cfRequest(
      "GET",
      `/accounts/${encodeURIComponent(accountId)}/storage/kv/namespaces/${encodeURIComponent(namespaceId)}/keys?${query.toString()}`
    );
    for (const key of result?.keys ?? []) {
      if (typeof key?.name !== "string" || !key.name.startsWith(customDomainPrefix)) continue;
      const hostname = key.name.slice(customDomainPrefix.length).trim().toLowerCase();
      if (hostname) hostnames.add(hostname);
    }
    cursor = result?.list_complete === false ? result?.cursor || null : null;
  } while (cursor);

  return [...hostnames];
};

const zones = await listZones();
const baseZone = resolveZoneForHostname(zones, zoneName);
if (!baseZone?.id) {
  throw new Error(`Unable to find Cloudflare zone for ${zoneName}.`);
}

await ensureWorkerRoute({
  zoneId: baseZone.id,
  pattern: `${zoneName}/*`
});

if (attachWildcardRoute) {
  await ensureWorkerRoute({
    zoneId: baseZone.id,
    pattern: `*.${zoneName}/*`
  });
}

const kvNamespaceId = await findKvNamespaceId();
const hostnames = await listCustomDomainHostnames(kvNamespaceId);
for (const hostname of hostnames) {
  const zone = resolveZoneForHostname(zones, hostname);
  if (!zone?.id) {
    console.warn(`Skipping ${hostname}: no matching Cloudflare zone is available.`);
    continue;
  }
  await ensureWorkerRoute({
    zoneId: zone.id,
    pattern: `${hostname}/*`
  });
}

console.log(
  JSON.stringify(
    {
      reconciled: true,
      zoneName,
      attachWildcardRoute,
      customDomains: hostnames.length
    },
    null,
    2
  )
);
