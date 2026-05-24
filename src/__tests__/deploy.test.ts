import { afterEach, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { app } from "../worker";
import { createTestEnv } from "./mocks";
import {
  loadCustomDomainMapping,
  loadDeploymentRecord,
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
        "backend/index.js": "export default { fetch(){ return new Response('backend') } }"
      }),
      env
    );

    expect(response.status).toBe(200);
    const record = await loadDeploymentRecord(env, "production", "w7s-io", "demo");
    expect(record?.targets.worker?.entrypoint).toBe("backend/index.js");
    expect(record?.targets.worker?.scriptName).toBe("w7s-io--demo--production--abc123");
  });
});
