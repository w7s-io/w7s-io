import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { app } from "../worker";
import { createTestEnv } from "./mocks";
import {
  loadCustomDomainMapping,
  loadDeploymentRecord,
  loadQueueMapping,
  storeCustomDomainMappings,
  type DeploymentRecord
} from "../storage/deployments";

const zipBytes = (files: Record<string, string>) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, value]) => [path, new TextEncoder().encode(value)])
    )
  );

const deployRequest = (files: Record<string, string>, headers: Record<string, string> = {}) =>
  new Request("https://w7s.cloud/api/v1/deploy", {
    method: "POST",
    headers: {
      authorization: "Bearer github-token",
      "content-type": "application/zip",
      "x-github-repository": "w7s-io/demo",
      "x-github-sha": "abc123",
      "x-github-branch": "main",
      ...headers
    },
    body: zipBytes(files)
  });

const deployValueHeader = (values: Record<string, string>) =>
  btoa(JSON.stringify(values)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const stubCustomDomainFetch = (params: {
  repository: string;
  txtAnswers?: string[];
}) =>
  vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.github.com/repos/")) {
      return Response.json({ full_name: params.repository });
    }
    if (url === "https://api.cloudflare.com/client/v4/zones?per_page=100") {
      return Response.json({
        success: true,
        result: [{ id: "zone-1", name: "carlosguerrero.com" }]
      });
    }
    if (url.startsWith("https://cloudflare-dns.com/dns-query")) {
      return Response.json({
        Answer: (params.txtAnswers ?? []).map((data) => ({
          type: 16,
          data
        }))
      });
    }
    if (url.includes("/workers/routes") && init?.method === "GET") {
      return Response.json({ success: true, result: [] });
    }
    if (url.includes("/workers/routes") && init?.method === "POST") {
      return Response.json({ success: true, result: { id: "route-1" } });
    }
    return Response.json({ success: true, result: {} });
  });

const existingDeploymentRecord = (params: {
  orgSlug: string;
  repoSlug: string;
}): DeploymentRecord => ({
  version: 1,
  orgSlug: params.orgSlug,
  repoSlug: params.repoSlug,
  environment: "production",
  repository: `${params.orgSlug}/${params.repoSlug}`,
  branch: "main",
  commitSha: "previous",
  deployedAt: "2026-05-23T00:00:00.000Z",
  targets: {}
});

describe("deploy API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes static deployments and stores metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/")) {
          return Response.json({ full_name: "w7s-io/demo" });
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const env = createTestEnv();
    const response = await app.fetch(
      deployRequest({
        "frontend/dist/index.html": "<h1>Hello</h1>",
        "frontend/dist/assets/app.js": "console.log('ok')"
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { status: string };
    expect(body.status).toBe("success");

    const record = await loadDeploymentRecord(env, "production", "w7s-io", "demo");
    expect(record?.targets.static?.manifestKey).toContain("abc123");
    expect(record?.targets.static?.fileCount).toBe(2);
    expect(record?.targets.worker).toBeUndefined();
  });

  it("publishes root dist static deployments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/")) {
          return Response.json({ full_name: "w7s-io/demo" });
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const env = createTestEnv();
    const response = await app.fetch(
      deployRequest({
        "dist/index.html": "<h1>Hello</h1>",
        "dist/assets/app.js": "console.log('ok')"
      }),
      env
    );

    expect(response.status).toBe(200);
    const record = await loadDeploymentRecord(env, "production", "w7s-io", "demo");
    expect(record?.targets.static?.fileCount).toBe(2);
    expect(record?.targets.static?.hasIndex).toBe(true);
  });

  it("returns org root URLs for same-name repo deployments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/")) {
          return Response.json({ full_name: "guerrerocarlos/guerrerocarlos" });
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const env = createTestEnv();
    const response = await app.fetch(
      deployRequest(
        {
          "frontend/dist/index.html": "<h1>Hello</h1>"
        },
        {
          "x-github-repository": "guerrerocarlos/guerrerocarlos"
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data?: { url?: string } };
    expect(body.data?.url).toBe("https://guerrerocarlos.w7s.cloud/");
  });

  it("returns branch-prefixed URLs for non-production branch deployments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/")) {
          return Response.json({ full_name: "w7s-io/demo" });
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const env = createTestEnv();
    const response = await app.fetch(
      deployRequest(
        {
          "frontend/dist/index.html": "<h1>Hello</h1>"
        },
        {
          "x-github-branch": "feature/login"
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json() as { data?: { url?: string } };
    expect(body.data?.url).toBe("https://feature-login--w7s-io.w7s.cloud/demo/");
    const record = await loadDeploymentRecord(env, "feature-login", "w7s-io", "demo");
    expect(record?.branch).toBe("feature/login");
  });

  it("attaches first unverified custom domain claims with setup warnings", async () => {
    vi.stubGlobal("fetch", stubCustomDomainFetch({ repository: "guerrerocarlos/whereis" }));
    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token"
    });
    const response = await app.fetch(
      deployRequest(
        {
          "CNAME": "whereis.carlosguerrero.com\n",
          "dist/client/index.html": "<h1>Hello</h1>"
        },
        {
          "x-github-repository": "guerrerocarlos/whereis"
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      data?: {
        url?: string;
        customDomains?: string[];
        customDomainWarnings?: Array<{ txtName?: string; txtValue?: string }>;
      };
    };
    expect(body.data?.url).toBe("https://whereis.carlosguerrero.com/");
    expect(body.data?.customDomains).toEqual(["whereis.carlosguerrero.com"]);
    expect(body.data?.customDomainWarnings).toEqual([
      expect.objectContaining({
        txtName: "_w7s.carlosguerrero.com",
        txtValue: "guerrerocarlos/whereis"
      })
    ]);
    const record = await loadDeploymentRecord(env, "production", "guerrerocarlos", "whereis");
    expect(record?.customDomains).toEqual(["whereis.carlosguerrero.com"]);
    const mapping = await loadCustomDomainMapping(env, "whereis.carlosguerrero.com");
    expect(mapping?.repoSlug).toBe("whereis");
  });

  it("attaches every hostname listed in a CNAME file", async () => {
    vi.stubGlobal("fetch", stubCustomDomainFetch({ repository: "guerrerocarlos/whereis" }));
    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token"
    });
    const response = await app.fetch(
      deployRequest(
        {
          "CNAME": "whereis.carlosguerrero.com\nwww.carlosguerrero.com\n# ignored\n",
          "dist/client/index.html": "<h1>Hello</h1>"
        },
        {
          "x-github-repository": "guerrerocarlos/whereis"
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      data?: {
        url?: string;
        customDomains?: string[];
        customDomainWarnings?: Array<{ hostname?: string }>;
      };
    };
    expect(body.data?.url).toBe("https://whereis.carlosguerrero.com/");
    expect(body.data?.customDomains).toEqual([
      "whereis.carlosguerrero.com",
      "www.carlosguerrero.com"
    ]);
    expect(body.data?.customDomainWarnings?.map((warning) => warning.hostname)).toEqual([
      "whereis.carlosguerrero.com",
      "www.carlosguerrero.com"
    ]);
    await expect(loadCustomDomainMapping(env, "whereis.carlosguerrero.com")).resolves.toEqual(
      expect.objectContaining({ repoSlug: "whereis" })
    );
    await expect(loadCustomDomainMapping(env, "www.carlosguerrero.com")).resolves.toEqual(
      expect.objectContaining({ repoSlug: "whereis" })
    );
  });

  it("removes stale custom domain mappings for the same deployment", async () => {
    vi.stubGlobal("fetch", stubCustomDomainFetch({ repository: "guerrerocarlos/whereis" }));
    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token"
    });
    const headers = {
      "x-github-repository": "guerrerocarlos/whereis"
    };

    const first = await app.fetch(
      deployRequest(
        {
          "CNAME": "whereis.carlosguerrero.com\n",
          "dist/client/index.html": "<h1>Hello</h1>"
        },
        headers
      ),
      env
    );
    expect(first.status).toBe(200);
    await expect(loadCustomDomainMapping(env, "whereis.carlosguerrero.com")).resolves.toEqual(
      expect.objectContaining({ repoSlug: "whereis" })
    );

    const second = await app.fetch(
      deployRequest(
        {
          "dist/client/index.html": "<h1>Hello again</h1>"
        },
        headers
      ),
      env
    );

    expect(second.status).toBe(200);
    await expect(loadCustomDomainMapping(env, "whereis.carlosguerrero.com")).resolves.toBeNull();
  });

  it("attaches custom domains when TXT authorizes the GitHub owner", async () => {
    vi.stubGlobal(
      "fetch",
      stubCustomDomainFetch({
        repository: "guerrerocarlos/whereis",
        txtAnswers: ['"guerrerocarlos"']
      })
    );
    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token"
    });
    const response = await app.fetch(
      deployRequest(
        {
          "CNAME": "whereis.carlosguerrero.com\n",
          "dist/client/index.html": "<h1>Hello</h1>"
        },
        {
          "x-github-repository": "guerrerocarlos/whereis"
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      data?: {
        customDomains?: string[];
        customDomainWarnings?: unknown[];
      };
    };
    expect(body.data?.customDomains).toEqual(["whereis.carlosguerrero.com"]);
    expect(body.data?.customDomainWarnings).toBeUndefined();
  });

  it("attaches custom domains when comma-separated TXT authorizes the repo", async () => {
    vi.stubGlobal(
      "fetch",
      stubCustomDomainFetch({
        repository: "guerrerocarlos/whereis",
        txtAnswers: ['"omattic,guerrerocarlos/whereis"']
      })
    );
    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token"
    });
    const response = await app.fetch(
      deployRequest(
        {
          "CNAME": "whereis.carlosguerrero.com\n",
          "dist/client/index.html": "<h1>Hello</h1>"
        },
        {
          "x-github-repository": "guerrerocarlos/whereis"
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      data?: {
        customDomains?: string[];
        blockedCustomDomains?: unknown[];
      };
    };
    expect(body.data?.customDomains).toEqual(["whereis.carlosguerrero.com"]);
    expect(body.data?.blockedCustomDomains).toBeUndefined();
  });

  it("blocks custom domains when TXT exists but does not authorize the repo", async () => {
    vi.stubGlobal(
      "fetch",
      stubCustomDomainFetch({
        repository: "guerrerocarlos/whereis",
        txtAnswers: ['"omattic"']
      })
    );
    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token"
    });
    const response = await app.fetch(
      deployRequest(
        {
          "CNAME": "whereis.carlosguerrero.com\n",
          "dist/client/index.html": "<h1>Hello</h1>"
        },
        {
          "x-github-repository": "guerrerocarlos/whereis"
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      data?: {
        url?: string;
        customDomains?: string[];
        blockedCustomDomains?: Array<{ reason?: string; txtName?: string }>;
      };
    };
    expect(body.data?.url).toBe("https://guerrerocarlos.w7s.cloud/whereis/");
    expect(body.data?.customDomains).toBeUndefined();
    expect(body.data?.blockedCustomDomains).toEqual([
      expect.objectContaining({
        reason: "txt_allowlist_mismatch",
        txtName: "_w7s.carlosguerrero.com"
      })
    ]);
    await expect(loadCustomDomainMapping(env, "whereis.carlosguerrero.com")).resolves.toBeNull();
  });

  it("keeps existing custom domain mappings on unverified conflicts", async () => {
    vi.stubGlobal("fetch", stubCustomDomainFetch({ repository: "guerrerocarlos/whereis" }));
    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token"
    });
    await storeCustomDomainMappings(
      env,
      existingDeploymentRecord({ orgSlug: "guerrerocarlos", repoSlug: "old-site" }),
      ["whereis.carlosguerrero.com"]
    );
    const response = await app.fetch(
      deployRequest(
        {
          "CNAME": "whereis.carlosguerrero.com\n",
          "dist/client/index.html": "<h1>Hello</h1>"
        },
        {
          "x-github-repository": "guerrerocarlos/whereis"
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      data?: {
        customDomains?: string[];
        blockedCustomDomains?: Array<{ reason?: string; currentRepository?: string }>;
      };
    };
    expect(body.data?.customDomains).toBeUndefined();
    expect(body.data?.blockedCustomDomains).toEqual([
      expect.objectContaining({
        reason: "already_claimed",
        currentRepository: "guerrerocarlos/old-site"
      })
    ]);
    const mapping = await loadCustomDomainMapping(env, "whereis.carlosguerrero.com");
    expect(mapping?.repoSlug).toBe("old-site");
  });

  it("replaces existing custom domain mappings when TXT authorizes the new repo", async () => {
    vi.stubGlobal(
      "fetch",
      stubCustomDomainFetch({
        repository: "guerrerocarlos/whereis",
        txtAnswers: ['"guerrerocarlos/whereis"']
      })
    );
    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token"
    });
    await storeCustomDomainMappings(
      env,
      existingDeploymentRecord({ orgSlug: "guerrerocarlos", repoSlug: "old-site" }),
      ["whereis.carlosguerrero.com"]
    );
    const response = await app.fetch(
      deployRequest(
        {
          "CNAME": "whereis.carlosguerrero.com\n",
          "dist/client/index.html": "<h1>Hello</h1>"
        },
        {
          "x-github-repository": "guerrerocarlos/whereis"
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    const mapping = await loadCustomDomainMapping(env, "whereis.carlosguerrero.com");
    expect(mapping?.repoSlug).toBe("whereis");
  });

  it("rejects unauthorized GitHub tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 }))
    );
    const env = createTestEnv();
    const response = await app.fetch(
      deployRequest({
        "dist/index.html": "<h1>Hello</h1>"
      }),
      env
    );

    expect(response.status).toBe(401);
  });

  it("accepts backend folders as native deployments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/")) {
          return Response.json({ full_name: "w7s-io/demo" });
        }
        if (
          url.includes("/workers/dispatch/namespaces/w7s-isolate/scripts/") &&
          init?.method === "PUT"
        ) {
          return Response.json({ success: true, result: { startup_time_ms: 5 } });
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-123"
    });
    const response = await app.fetch(
      deployRequest({
        "backend/index.js": "export default { fetch(){ return new Response('backend') } }",
        "w7s.json": JSON.stringify({
          rpc: {
            allow: ["guerrerocarlos/notepad"]
          }
        })
      }),
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      data?: { deployment?: { rpc?: Record<string, unknown>; queue?: Record<string, unknown> } };
    };
    const record = await loadDeploymentRecord(env, "production", "w7s-io", "demo");
    expect(record?.targets.worker?.entrypoint).toBe("backend/index.js");
    expect(record?.targets.worker?.scriptName).toBe("w7s-io--demo--production--abc123");
    expect(record?.rpc?.allow).toEqual(["guerrerocarlos/notepad"]);
    expect(body.data?.deployment?.rpc).toEqual({
      binding: "W7S_RPC",
      allow: ["guerrerocarlos/notepad"]
    });
    expect(body.data?.deployment?.queue).toEqual({
      binding: "W7S_QUEUE",
      allow: [],
      queues: []
    });
  });

  it("provisions declared queues and uploads queue runtime bindings", async () => {
    const uploadedMetadata: Array<{
      bindings?: Array<Record<string, string>>;
    }> = [];
    const createdConsumers: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/")) {
          return Response.json({ full_name: "w7s-io/demo" });
        }
        if (url.includes("/queues?")) {
          return Response.json({ success: true, result: [] });
        }
        if (url.endsWith("/queues") && init?.method === "POST") {
          return Response.json({
            success: true,
            result: {
              queue_id: "queue-1",
              queue_name: "w7s-production-w7s-io-demo-queue-jobs"
            }
          });
        }
        if (url.endsWith("/queues/queue-1/consumers") && init?.method !== "POST") {
          return Response.json({ success: true, result: [] });
        }
        if (url.endsWith("/queues/queue-1/consumers") && init?.method === "POST") {
          createdConsumers.push(JSON.parse(String(init.body)));
          return Response.json({
            success: true,
            result: {
              consumer_id: "consumer-1",
              type: "worker",
              script_name: "w7s-io"
            }
          });
        }
        if (
          url.includes("/workers/dispatch/namespaces/w7s-isolate/scripts/") &&
          init?.method === "PUT"
        ) {
          const form = init.body as FormData;
          const metadata = form.get("metadata") as Blob;
          uploadedMetadata.push(JSON.parse(await metadata.text()));
          return Response.json({ success: true, result: { startup_time_ms: 5 } });
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-123"
    });
    const response = await app.fetch(
      deployRequest({
        "backend/index.js": "export default { fetch(){ return new Response('backend') } }",
        "w7s.json": JSON.stringify({
          queues: ["jobs"],
          queue: {
            allow: ["guerrerocarlos/notepad"]
          }
        })
      }),
      env
    );

    expect(response.status).toBe(200);
    const record = await loadDeploymentRecord(env, "production", "w7s-io", "demo");
    expect(record?.queue?.allow).toEqual(["guerrerocarlos/notepad"]);
    expect(record?.queue?.queues).toEqual([
      {
        name: "jobs",
        queueName: "w7s-production-w7s-io-demo-queue-jobs",
        queueId: "queue-1",
        consumer: "/_w7s/queues/jobs"
      }
    ]);
    expect(await loadQueueMapping(env, "w7s-production-w7s-io-demo-queue-jobs")).toEqual(
      expect.objectContaining({
        queue: "jobs",
        queueId: "queue-1",
        orgSlug: "w7s-io",
        repoSlug: "demo"
      })
    );
    expect(createdConsumers).toEqual([
      {
        type: "worker",
        script_name: "w7s-io"
      }
    ]);
    expect(uploadedMetadata[0]?.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "service", name: "W7S_QUEUE", service: "w7s-io" }),
        expect.objectContaining({ type: "secret_text", name: "W7S_QUEUE_TOKEN" })
      ])
    );
  });

  it("accepts Cloudflare dist/server deployments with dist/client assets", async () => {
    const uploadedMetadata: Array<{
      bindings?: Array<Record<string, string>>;
      compatibility_flags?: string[];
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/")) {
          return Response.json({ full_name: "w7s-io/demo" });
        }
        if (
          url.includes("/workers/dispatch/namespaces/w7s-isolate/scripts/") &&
          init?.method === "PUT"
        ) {
          const form = init.body as FormData;
          const metadata = form.get("metadata") as Blob;
          uploadedMetadata.push(JSON.parse(await metadata.text()));
          return Response.json({ success: true, result: { startup_time_ms: 5 } });
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-123"
    });
    const response = await app.fetch(
      deployRequest({
        "dist/server/index.js": "import { worker } from './assets/worker-entry.js'; import 'node:events'; export default worker;",
        "dist/server/assets/worker-entry.js": "export const worker = { fetch(){ return new Response('ssr') } };",
        "dist/server/wrangler.json": JSON.stringify({
          compatibility_date: "2025-09-24",
          compatibility_flags: ["nodejs_compat"]
        }),
        "dist/client/assets/app.js": "console.log('client')"
      }),
      env
    );

    expect(response.status).toBe(200);
    const record = await loadDeploymentRecord(env, "production", "w7s-io", "demo");
    expect(record?.targets.worker?.entrypoint).toBe("dist/server/index.js");
    expect(record?.targets.static?.fileCount).toBe(1);
    expect(record?.targets.static?.hasIndex).toBe(false);
    expect(record?.rpc?.binding).toBe("W7S_RPC");
    expect(record?.rpc?.tokenHash).toEqual(expect.any(String));
    expect(uploadedMetadata[0]?.compatibility_flags).toEqual(["nodejs_compat"]);
    expect(uploadedMetadata[0]?.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "service", name: "W7S_RPC", service: "w7s-io" }),
        expect.objectContaining({ type: "secret_text", name: "W7S_RPC_TOKEN" }),
        { type: "plain_text", name: "W7S_REPOSITORY", text: "w7s-io/demo" }
      ])
    );
  });

  it("provisions declared app storage and uploads runtime bindings", async () => {
    const uploadedMetadata: {
      bindings?: Array<Record<string, string>>;
    }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/")) {
          return Response.json({ full_name: "w7s-io/demo" });
        }
        if (url.includes("/storage/kv/namespaces") && init?.method !== "POST") {
          return Response.json({ success: true, result: [] });
        }
        if (url.includes("/storage/kv/namespaces") && init?.method === "POST") {
          return Response.json({ success: true, result: { id: "kv-1", title: "cache" } });
        }
        if (url.includes("/r2/buckets/") && init?.method !== "POST") {
          return new Response("missing", { status: 404 });
        }
        if (url.endsWith("/r2/buckets") && init?.method === "POST") {
          return Response.json({ success: true, result: { name: "files" } });
        }
        if (url.includes("/d1/database?")) {
          return Response.json({ success: true, result: [] });
        }
        if (url.endsWith("/d1/database") && init?.method === "POST") {
          return Response.json({ success: true, result: { uuid: "d1-1", name: "db" } });
        }
        if (url.includes("/d1/database/d1-1/query") && init?.method === "POST") {
          return Response.json({ success: true, result: [{ success: true, results: [] }] });
        }
        if (
          url.includes("/workers/dispatch/namespaces/w7s-isolate/scripts/") &&
          init?.method === "PUT"
        ) {
          const form = init.body as FormData;
          const metadata = form.get("metadata") as Blob;
          uploadedMetadata.push(JSON.parse(await metadata.text()));
          return Response.json({ success: true, result: { startup_time_ms: 5 } });
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-123"
    });
    const response = await app.fetch(
      deployRequest(
        {
          "w7s.json": JSON.stringify({
            bindings: {
              kv: ["CACHE"],
              r2: ["FILES"],
              d1: [{ binding: "DB", migrations: "migrations" }]
            },
            vars: ["GOOGLE_CLIENT_ID"],
            secrets: ["GOOGLE_CLIENT_SECRET"]
          }),
          "backend/index.js": "export default { fetch(_request, env){ return new Response(env.GOOGLE_CLIENT_ID) } }",
          "migrations/0001_init.sql": "CREATE TABLE notes (id TEXT PRIMARY KEY);"
        },
        {
          "x-w7s-vars": deployValueHeader({
            GOOGLE_CLIENT_ID: "client-id"
          }),
          "x-w7s-secrets": deployValueHeader({
            GOOGLE_CLIENT_SECRET: "client-secret"
          })
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    const record = await loadDeploymentRecord(env, "production", "w7s-io", "demo");
    expect(record?.bindings?.kv).toEqual([
      expect.objectContaining({
        binding: "CACHE",
        namespaceId: "kv-1"
      })
    ]);
    expect(record?.bindings?.r2).toEqual([
      expect.objectContaining({
        binding: "FILES"
      })
    ]);
    expect(record?.bindings?.d1).toEqual([
      expect.objectContaining({
        binding: "DB",
        databaseId: "d1-1",
        migrationsApplied: 1
      })
    ]);
    expect(record?.bindings?.vars).toEqual(["GOOGLE_CLIENT_ID"]);
    expect(record?.bindings?.secrets).toEqual(["GOOGLE_CLIENT_SECRET"]);
    expect(uploadedMetadata[0]?.bindings).toEqual(
      expect.arrayContaining([
        { type: "kv_namespace", name: "CACHE", namespace_id: "kv-1" },
        expect.objectContaining({ type: "r2_bucket", name: "FILES" }),
        { type: "d1", name: "DB", id: "d1-1" },
        { type: "plain_text", name: "GOOGLE_CLIENT_ID", text: "client-id" },
        { type: "secret_text", name: "GOOGLE_CLIENT_SECRET", text: "client-secret" }
      ])
    );
  });

  it("uploads durable object bindings and only creates new classes once", async () => {
    const uploadedMetadata: {
      bindings?: Array<Record<string, string>>;
      migrations?: {
        new_tag?: string;
        old_tag?: string;
        steps?: Array<{ new_sqlite_classes?: string[] }>;
      };
    }[] = [];
    let existingMigrationTag: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/")) {
          return Response.json({ full_name: "w7s-io/demo" });
        }
        if (url.endsWith("/workers/dispatch/namespaces/w7s-isolate")) {
          return Response.json({ success: true, result: {} });
        }
        if (
          url.includes("/workers/dispatch/namespaces/w7s-isolate/scripts/") &&
          init?.method !== "PUT"
        ) {
          if (!existingMigrationTag) return new Response("missing", { status: 404 });
          return Response.json({
            success: true,
            result: {
              script: {
                migration_tag: existingMigrationTag
              }
            }
          });
        }
        if (
          url.includes("/workers/dispatch/namespaces/w7s-isolate/scripts/") &&
          init?.method === "PUT"
        ) {
          const form = init.body as FormData;
          const metadata = form.get("metadata") as Blob;
          uploadedMetadata.push(JSON.parse(await metadata.text()));
          return Response.json({ success: true, result: { startup_time_ms: 5 } });
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-123"
    });
    const files = {
      "backend/index.js": [
        "export class Counter {",
        "  constructor(state) { this.state = state; }",
        "  async fetch() { return new Response('ok'); }",
        "}",
        "export default {",
        "  fetch(request, env) {",
        "    const id = env.COUNTER.idFromName('global');",
        "    return env.COUNTER.get(id).fetch(request);",
        "  }",
        "};"
      ].join("\n"),
      "w7s.json": JSON.stringify({
        bindings: {
          durableObjects: [
            {
              binding: "COUNTER",
              className: "Counter"
            }
          ]
        }
      })
    };

    const first = await app.fetch(deployRequest(files), env);
    expect(first.status).toBe(200);
    const firstRecord = await loadDeploymentRecord(env, "production", "w7s-io", "demo");
    expect(firstRecord?.targets.worker?.scriptName).toBe("w7s-io--demo--production");
    expect(firstRecord?.bindings?.durableObjects).toEqual([
      {
        binding: "COUNTER",
        className: "Counter"
      }
    ]);
    expect(uploadedMetadata[0]?.bindings).toEqual(
      expect.arrayContaining([
        {
          type: "durable_object_namespace",
          name: "COUNTER",
          class_name: "Counter"
        }
      ])
    );
    expect(uploadedMetadata[0]?.migrations).toEqual({
      new_tag: expect.stringMatching(/^w7s-do-/),
      steps: [
        {
          new_sqlite_classes: ["Counter"]
        }
      ]
    });

    existingMigrationTag = uploadedMetadata[0]?.migrations?.new_tag ?? null;
    const second = await app.fetch(
      deployRequest(files, {
        "x-github-sha": "def456"
      }),
      env
    );

    expect(second.status).toBe(200);
    const secondRecord = await loadDeploymentRecord(env, "production", "w7s-io", "demo");
    expect(secondRecord?.targets.worker?.scriptName).toBe("w7s-io--demo--production");
    expect(uploadedMetadata[1]?.migrations).toBeUndefined();

    const expandedFiles = {
      ...files,
      "backend/index.js": [
        "export class Counter {",
        "  async fetch() { return new Response('counter'); }",
        "}",
        "export class Limiter {",
        "  async fetch() { return new Response('limiter'); }",
        "}",
        "export default {",
        "  fetch(request, env) {",
        "    const id = env.LIMITER.idFromName('global');",
        "    return env.LIMITER.get(id).fetch(request);",
        "  }",
        "};"
      ].join("\n"),
      "w7s.json": JSON.stringify({
        bindings: {
          durableObjects: [
            {
              binding: "COUNTER",
              className: "Counter"
            },
            {
              binding: "LIMITER",
              className: "Limiter"
            }
          ]
        }
      })
    };
    const third = await app.fetch(
      deployRequest(expandedFiles, {
        "x-github-sha": "fed789"
      }),
      env
    );

    expect(third.status).toBe(200);
    expect(uploadedMetadata[2]?.migrations).toEqual({
      old_tag: existingMigrationTag,
      new_tag: expect.stringMatching(/^w7s-do-/),
      steps: [
        {
          new_sqlite_classes: ["Limiter"]
        }
      ]
    });
  });

  it("rejects durable objects on static-only deployments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/")) {
          return Response.json({ full_name: "w7s-io/demo" });
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const env = createTestEnv();
    const response = await app.fetch(
      deployRequest({
        "dist/index.html": "<h1>Hello</h1>",
        "w7s.json": JSON.stringify({
          bindings: {
            durableObjects: [
              {
                binding: "COUNTER",
                className: "Counter"
              }
            ]
          }
        })
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        error: "Durable Objects require a native backend deployment."
      })
    );
  });

  it("uploads declared Hyperdrive bindings", async () => {
    const uploadedMetadata: {
      bindings?: Array<Record<string, string>>;
    }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/")) {
          return Response.json({ full_name: "w7s-io/demo" });
        }
        if (url.endsWith("/workers/dispatch/namespaces/w7s-isolate")) {
          return Response.json({ success: true, result: {} });
        }
        if (
          url.includes("/workers/dispatch/namespaces/w7s-isolate/scripts/") &&
          init?.method === "PUT"
        ) {
          const form = init.body as FormData;
          const metadata = form.get("metadata") as Blob;
          uploadedMetadata.push(JSON.parse(await metadata.text()));
          return Response.json({ success: true, result: { startup_time_ms: 5 } });
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const env = createTestEnv({
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ACCOUNT_ID: "acct-123"
    });
    const response = await app.fetch(
      deployRequest({
        "backend/index.js": "export default { fetch(_request, env){ return Response.json({ hasDb: Boolean(env.DB) }) } }",
        "w7s.json": JSON.stringify({
          bindings: {
            hyperdrive: [
              {
                binding: "DB",
                id: "hyperdrive-123"
              }
            ]
          }
        })
      }),
      env
    );

    expect(response.status).toBe(200);
    const record = await loadDeploymentRecord(env, "production", "w7s-io", "demo");
    expect(record?.bindings?.hyperdrive).toEqual([
      {
        binding: "DB",
        id: "hyperdrive-123"
      }
    ]);
    expect(uploadedMetadata[0]?.bindings).toEqual(
      expect.arrayContaining([
        {
          type: "hyperdrive",
          name: "DB",
          id: "hyperdrive-123"
        }
      ])
    );
  });

  it("rejects Hyperdrive bindings on static-only deployments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/")) {
          return Response.json({ full_name: "w7s-io/demo" });
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const env = createTestEnv();
    const response = await app.fetch(
      deployRequest({
        "dist/index.html": "<h1>Hello</h1>",
        "w7s.json": JSON.stringify({
          bindings: {
            hyperdrive: [
              {
                binding: "DB",
                id: "hyperdrive-123"
              }
            ]
          }
        })
      }),
      env
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(
      expect.objectContaining({
        error: "Hyperdrive bindings require a native backend deployment."
      })
    );
  });

  it("rejects invalid app manifests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("https://api.github.com/repos/")) {
          return Response.json({ full_name: "w7s-io/demo" });
        }
        return Response.json({ success: true, result: {} });
      })
    );
    const env = createTestEnv();
    const response = await app.fetch(
      deployRequest({
        "w7s.json": "{",
        "frontend/dist/index.html": "<h1>Hello</h1>"
      }),
      env
    );

    expect(response.status).toBe(400);
  });
});
