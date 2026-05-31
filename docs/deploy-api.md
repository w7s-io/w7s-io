# Deploy API

## Endpoint

```text
POST https://w7s.cloud/api/v1/deploy
```

The body must be a zip archive of the full repository or a deployable subdirectory.

## Required Headers

```text
Authorization: Bearer <github-token>
x-github-repository: <owner>/<repo>
x-github-sha: <commit-sha>
x-github-branch: <branch-name>
content-type: application/zip
```

`application/octet-stream` is also accepted for zip uploads.

Optional runtime value headers:

```text
x-w7s-vars: <base64url-json-object>
x-w7s-secrets: <base64url-json-object>
```

The official `w7s-io/w7s-cloud@v1` action writes these headers from the workflow environment. Names listed in `w7s.json` are collected automatically, and extra names can be passed with the action's `vars` and `secrets` inputs.

## Authentication

The deploy token is checked against GitHub:

```text
GET https://api.github.com/repos/<owner>/<repo>
Authorization: Bearer <github-token>
```

If GitHub returns `401`, `403`, or `404`, W7S rejects the deploy with `401`.

This means deploy permission is equivalent to GitHub repo read access. The intended caller is GitHub Actions using `${{ github.token }}`.

## Environment Selection

Optional overrides:

- query: `?environment=staging`
- header: `x-w7s-environment: staging`

Default behavior:

- `main` and `master` deploy to `production`;
- all other branches deploy to a sanitized branch environment.

Environment names are DNS-safe. W7S lowercases the branch or explicit override, replaces runs of characters outside `a-z`, `0-9`, and `-` with `-`, collapses repeated hyphens, trims leading/trailing hyphens, and caps the result at 63 characters.

Production deployments are served from:

```text
https://<org>.w7s.cloud/<repo>/
```

Non-production branch deployments are served from:

```text
https://<branch-environment>--<org>.w7s.cloud/<repo>/
```

For example, branch `feature/API.v2_test` is stored as environment `feature-api-v2-test` and served from:

```text
https://feature-api-v2-test--<org>.w7s.cloud/<repo>/
```

## Archive Layout

Native backend roots:

```text
backend/index.js
backend/index.mjs
backend/index.ts
backend/index.mts
worker/index.js
worker/index.mjs
worker/index.ts
worker/index.mts
dist/server/index.js
dist/server/index.mjs
```

Static frontend root:

```text
frontend/dist/
frontend/build/
frontend/out/
dist/client/
dist/
build/
out/
```

Both native backend and static frontend can be present in the same archive.

If a native folder such as `backend/` is present but does not contain one of the supported `index.*` entrypoints, W7S still deploys a valid static frontend and returns a `deploymentWarnings` entry explaining that the backend was skipped. If there is no deployable frontend, the same archive is rejected.

Cloudflare/Vite SSR builds are supported with:

```text
dist/server/index.js
dist/client/assets/...
```

## Free-Tier Shape Caps

W7S rejects deploys that are too large or declare too many resources before anything is published:

```text
archive zip bytes       25 MB
uncompressed bytes      100 MB
static files            1000
static total bytes      100 MB
static single file      10 MB
KV bindings             3
R2 bindings             3
D1 bindings             2
Durable Object classes  2
queues                  2
schedules               5
workflows               5
custom domains          3
D1 migration files      50
D1 migration SQL bytes  5 MB
```

Native Workers are dispatched with a custom CPU limit from `W7S_USER_WORKER_CPU_MS`, default `50`, and a subrequest limit from `W7S_USER_WORKER_SUBREQUESTS`, default `25`.

When `dist/server/wrangler.json` contains `compatibility_flags`, W7S includes those flags in the uploaded Worker metadata. This supports framework builds that require flags such as `nodejs_compat`.

Optional custom domain declaration:

```text
CNAME
frontend/CNAME
frontend/dist/CNAME
dist/client/CNAME
dist/CNAME
build/CNAME
out/CNAME
```

Optional app manifest:

```text
w7s.json
```

Example:

```json
{
  "bindings": {
    "kv": ["CACHE"],
    "r2": ["FILES"],
    "d1": [
      {
        "binding": "DB",
        "migrations": "migrations"
      }
    ],
    "durableObjects": [
      {
        "binding": "COUNTER",
        "className": "Counter"
      }
    ],
    "hyperdrive": [
      {
        "binding": "DB",
        "id": "cloudflare-hyperdrive-id"
      }
    ]
  },
  "queues": ["jobs"],
  "schedules": [
    {
      "cron": "*/5 * * * *",
      "path": "/_w7s/schedules/sync"
    }
  ],
  "vars": ["PUBLIC_API_KEY"],
  "secrets": ["PRIVATE_API_KEY"],
  "queue": {
    "allow": ["guerrerocarlos/notepad", "w7s-io"]
  },
  "rpc": {
    "allow": ["guerrerocarlos/notepad", "w7s-io"]
  }
}
```

`bindings.kv` entries create Workers KV namespaces. `bindings.r2` entries create R2 buckets. `bindings.d1` entries create D1 databases. `bindings.durableObjects` entries bind Durable Object classes exported by the native Worker. `bindings.hyperdrive` entries bind existing Cloudflare Hyperdrive configurations by ID. String storage entries use generated resource names; object entries can provide explicit names:

```json
{
  "bindings": {
    "kv": [{ "binding": "CACHE", "name": "my-cache-namespace" }],
    "r2": [{ "binding": "FILES", "bucket": "my-files-bucket" }],
    "d1": [{ "binding": "DB", "name": "my-app-db", "migrations": "migrations" }]
  }
}
```

Managed storage is scoped to `<environment>/<owner>/<repo>/<binding>`, so redeploys reuse durable resources while non-production branches get separate resources.

D1 migrations are read from the configured migrations directory, sorted by filename, and applied once. W7S tracks applied migration filenames in `_w7s_migrations` inside the app database.

Durable Objects require a native backend deployment. W7S uploads each declaration as a `durable_object_namespace` binding and creates SQLite-backed classes automatically the first time it sees them:

```json
{
  "bindings": {
    "durableObjects": [
      {
        "binding": "COUNTER",
        "className": "Counter"
      }
    ]
  }
}
```

The backend must export the class named by `className`. DO-enabled apps use a stable per-repo/environment Worker script name so Durable Object state survives redeploys. W7S does not automate DO class renames, transfers, or deletes yet.

Hyperdrive bindings require a native backend deployment and an existing Cloudflare Hyperdrive config ID:

```json
{
  "bindings": {
    "hyperdrive": [
      {
        "binding": "DB",
        "id": "cloudflare-hyperdrive-id"
      }
    ]
  }
}
```

W7S uploads those declarations as `hyperdrive` Worker bindings. It does not create Hyperdrive configs or rotate database credentials yet. Apps using common Postgres drivers usually need a bundled backend and Node.js compatibility flags from `dist/server/wrangler.json`.

`rpc.allow` is optional. Same-owner backend-to-backend calls are allowed by default. Cross-owner calls are accepted only when the target app lists the caller GitHub owner or exact `owner/repo`.

`queues` declares app-owned Cloudflare Queues. String entries use the default consumer route `/_w7s/queues/<queue>`. Object entries can override the consumer route:

```json
{
  "queues": [
    "jobs",
    {
      "name": "emails",
      "consumer": "/internal/queues/emails"
    }
  ]
}
```

`queue.allow` is optional. Same-owner queue sends are allowed by default. Cross-owner sends are accepted only when the target app lists the caller GitHub owner or exact `owner/repo`.

`schedules` declares cron-driven backend jobs. Each schedule has a five-field UTC cron expression and an absolute backend path:

```json
{
  "schedules": [
    {
      "cron": "*/5 * * * *",
      "path": "/_w7s/schedules/sync"
    }
  ]
}
```

Cron fields support `*`, `*/n`, numeric values, lists, and ranges with optional steps. Schedules require a native backend deployment. W7S core receives a per-minute Cloudflare scheduled event, matches app schedules against that scheduled minute, and dispatches due jobs to the configured path with a JSON payload:

```json
{
  "schedule": "*/5 * * * *",
  "scheduledTime": "2026-05-25T12:00:00.000Z",
  "repository": "owner/repo",
  "environment": "production"
}
```

The schedule dispatch includes these headers:

```text
x-w7s-schedule: 1
x-w7s-schedule-cron: <cron>
x-w7s-schedule-time: <scheduled-minute-iso>
```

The `CNAME` file should contain one hostname, for example:

```text
whereis.carlosguerrero.com
```

W7S reads root `CNAME` first, then static-output and legacy `frontend` CNAME paths. It stores a host mapping in KV and attaches a Cloudflare Worker route for `<hostname>/*` when the domain's Cloudflare zone is available to the W7S API token. The actual DNS record still has to resolve to Cloudflare. For a typical proxied Cloudflare zone, create a `CNAME` record for the host that points at `w7s.cloud`.

Custom-domain ownership is intentionally low-friction:

- a repo can attach a hostname without a TXT record;
- W7S returns `customDomainWarnings` recommending a TXT allowlist for future safety;
- if `_w7s.<zone>` exists, only GitHub owners or repos listed in that TXT record can use hostnames on that zone;
- if no TXT allowlist exists, the latest deployment wins and replaces any previous unverified hostname claim.

Example TXT record for `whereis.carlosguerrero.com`:

```text
Name: _w7s.carlosguerrero.com
Value: guerrerocarlos
```

The value is comma-separated. `guerrerocarlos` allows any repo under that owner. `guerrerocarlos/whereis` allows only that repo. This also supports mixed values such as `guerrerocarlos/whereis,omattic`.

## Native Backend Rules

The native backend is published to Cloudflare Workers for Platforms.

W7S also attaches the W7S core Worker as a Tail Worker consumer on uploaded native backends, unless worker logs are disabled by the platform operator. This is what powers `GET /api/v1/logs/<owner>/<repo>` for app `console.*` output and uncaught exceptions.

Supported imports:

- relative imports inside the same root, such as `./lib.js`;
- TypeScript files are transpiled with Babel before upload.

Unsupported imports:

- bare package imports such as `import x from "pkg"`;
- imports crossing outside `backend/` or `worker/`.

`node:` runtime imports are allowed for built Cloudflare Workers when the required compatibility flag is present in `dist/server/wrangler.json`.

If a repo needs dependencies, it should bundle in CI and upload the bundled backend files.

## Backend AI

W7S injects these bindings into every native backend:

- `W7S_AI`: service binding to the W7S core Worker;
- `W7S_AI_TOKEN`: secret bearer token for the current deployment.

Call the AI runner through the service binding:

```ts
const response = await env.W7S_AI.fetch("https://w7s.internal/api/v1/ai/run", {
  method: "POST",
  headers: {
    authorization: `Bearer ${env.W7S_AI_TOKEN}`,
    "content-type": "application/json"
  },
  body: JSON.stringify({
    model: "@w7s/meta/llama-3.1-8b-instruct-fp8",
    input: { prompt: "Write one short deployment joke." }
  })
});
```

The response shape is:

```json
{
  "status": "success",
  "data": {
    "model": "@w7s/meta/llama-3.1-8b-instruct-fp8",
    "result": {
      "response": "..."
    }
  }
}
```

W7S verifies the caller token, applies app suspension and `ai.run` usage limits, and then calls the core AI binding. Repos do not need provider account IDs, provider API tokens, or GitHub secrets for this binding.

## Backend RPC

Native backends receive these bindings automatically:

- `W7S_RPC`: service binding to the W7S core Worker;
- `W7S_RPC_TOKEN`: secret bearer token for the current deployment;
- `W7S_OWNER`;
- `W7S_REPO`;
- `W7S_REPOSITORY`;
- `W7S_ENVIRONMENT`.

Call another backend in the same environment through:

```ts
const response = await env.W7S_RPC.fetch(
  "https://w7s.internal/api/v1/rpc/guerrerocarlos/auth/session",
  {
    headers: {
      authorization: `Bearer ${env.W7S_RPC_TOKEN}`
    }
  }
);
```

The target path is `/api/v1/rpc/<owner>/<repo>/<path>`. W7S verifies the caller token, resolves the caller deployment, loads the target deployment from the same environment, and dispatches directly to the target backend. Public request auth headers are stripped before dispatch.

The target Worker receives caller identity headers:

```text
x-w7s-rpc: 1
x-w7s-rpc-caller-owner: <owner>
x-w7s-rpc-caller-repo: <repo>
x-w7s-rpc-caller-repository: <owner>/<repo>
x-w7s-rpc-caller-environment: <environment>
```

## Backend Queues

Native backends receive these queue bindings automatically:

- `W7S_QUEUE`: service binding to the W7S core Worker;
- `W7S_QUEUE_TOKEN`: secret bearer token for the current deployment.

Send a JSON message to a declared target queue:

```ts
await env.W7S_QUEUE.fetch(
  "https://w7s.internal/api/v1/queues/w7s-io/example-worker/jobs",
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.W7S_QUEUE_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ type: "work", id: "123" })
  }
);
```

The target path is `/api/v1/queues/<owner>/<repo>/<queue>`. W7S verifies the caller token, resolves the caller deployment, loads the target deployment from the same environment, verifies that the target declares the queue, and sends the message to the managed queue.

W7S core receives Cloudflare Queue batches and dispatches them to the target app's consumer route:

```json
{
  "queue": "jobs",
  "queueName": "w7s-production-w7s-io-example-worker-queue-jobs",
  "messages": [
    {
      "id": "message-id",
      "attempts": 1,
      "timestamp": "2026-05-24T22:00:00.000Z",
      "enqueuedAt": "2026-05-24T21:59:59.000Z",
      "caller": {
        "repository": "w7s-io/example-client"
      },
      "body": {
        "type": "work",
        "id": "123"
      }
    }
  ]
}
```

## Static Frontend Rules

Every file under the first detected static root is uploaded to R2. Detection order is:

1. `frontend/dist`
2. `dist/client`
3. `dist`
4. `build`
5. `out`

Legacy `frontend/dist` is accepted as an explicit W7S root. The other roots are accepted when they contain `index.html`, which prevents W7S from publishing unrelated build folders by accident. `dist/client` may omit `index.html` when it is paired with a native `dist/server` Worker.

Static routes:

- exact file paths are served first;
- `/` and directory paths resolve to `index.html` where present;
- if native backend returns `404` or `405`, W7S serves `index.html` as SPA fallback when available.

## Success Response

Example:

```json
{
  "status": "success",
  "data": {
    "deployment": {
      "version": 1,
      "orgSlug": "guerrerocarlos",
      "repoSlug": "w7s-io-demo",
      "environment": "production",
      "repository": "guerrerocarlos/w7s-io-demo",
      "branch": "main",
      "commitSha": "abc123",
      "deployedAt": "2026-05-23T17:15:11.770Z",
      "targets": {
        "worker": {
          "namespace": "w7s-isolate",
          "scriptName": "guerrerocarlos--w7s-io-demo--production--abc123",
          "entrypoint": "backend/index.js",
          "compatibilityDate": "2026-05-23",
          "startupTimeMs": 0
        },
        "static": {
          "manifestKey": "static_manifest:v1:production:guerrerocarlos:w7s-io-demo:static-v1-production-guerrerocarlos-w7s-io-demo-abc123",
          "assetPrefix": "static/v1/production/guerrerocarlos/w7s-io-demo/abc123",
          "fileCount": 3,
          "hasIndex": true
        }
      },
      "bindings": {
        "kv": [
          {
            "binding": "CACHE",
            "name": "w7s-production-guerrerocarlos-w7s-io-demo-kv-cache",
            "namespaceId": "0f2ac74b498b48028cb68387c421e279"
          }
        ],
        "d1": [
          {
            "binding": "DB",
            "name": "w7s-production-guerrerocarlos-w7s-io-demo-d1-db",
            "databaseId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
            "migrationsApplied": 1
          }
        ],
        "vars": ["PUBLIC_API_KEY"],
        "secrets": ["PRIVATE_API_KEY"]
      },
      "customDomains": ["whereis.carlosguerrero.com"]
    },
    "url": "https://whereis.carlosguerrero.com/",
    "customDomains": ["whereis.carlosguerrero.com"],
    "deploymentWarnings": [
      {
        "code": "native_backend_skipped",
        "target": "backend",
        "message": "backend/ was present, but W7S did not deploy a backend because no supported backend entrypoint was found. The frontend was published normally.",
        "requiredEntrypoints": [
          "worker/index.js",
          "worker/index.mjs",
          "worker/index.ts",
          "worker/index.mts",
          "backend/index.js",
          "backend/index.mjs",
          "backend/index.ts",
          "backend/index.mts",
          "dist/server/index.js",
          "dist/server/index.mjs"
        ]
      }
    ],
    "customDomainWarnings": [
      {
        "hostname": "whereis.carlosguerrero.com",
        "domain": "carlosguerrero.com",
        "txtName": "_w7s.carlosguerrero.com",
        "txtValue": "guerrerocarlos/w7s-io-demo",
        "message": "Add TXT _w7s.carlosguerrero.com=guerrerocarlos/w7s-io-demo to restrict future claims for this domain."
      }
    ]
  }
}
```

When a custom domain is blocked, the deployment still publishes and returns the normal `w7s.cloud` URL:

```json
{
  "status": "success",
  "data": {
    "url": "https://guerrerocarlos.w7s.cloud/whereis/",
    "blockedCustomDomains": [
      {
        "hostname": "whereis.carlosguerrero.com",
        "domain": "carlosguerrero.com",
        "reason": "txt_allowlist_mismatch",
        "txtName": "_w7s.carlosguerrero.com",
        "txtValue": "guerrerocarlos/whereis",
        "message": "TXT _w7s.carlosguerrero.com does not authorize guerrerocarlos/whereis."
      }
    ]
  }
}
```

For same-name repos, the public URL is the org root. A deploy from `guerrerocarlos/guerrerocarlos` returns:

```json
{
  "status": "success",
  "data": {
    "url": "https://guerrerocarlos.w7s.cloud/"
  }
}
```

## Common Failures

- `401 Missing bearer token`
  - `Authorization: Bearer ...` is absent.
- `401 Bearer token is not authorized`
  - GitHub token cannot read the repo in `x-github-repository`.
- `400 Archive must contain worker/, backend/, dist/server/, or static frontend output`
  - Archive does not contain a deployable root.
- `400 Native backend deploy requires ...`
  - A native folder exists but no supported `index.*` entrypoint exists, and there is no deployable frontend to publish.
- `200 success` with `deploymentWarnings`
  - A deployable frontend was published, but a native folder such as `backend/` was skipped because it does not contain a supported `index.*` entrypoint.
- `400 Durable Objects require a native backend deployment.`
  - `w7s.json` declares `bindings.durableObjects`, but the archive only contains static frontend output.
- `400 Hyperdrive bindings require a native backend deployment.`
  - `w7s.json` declares `bindings.hyperdrive`, but the archive only contains static frontend output.
- `400 Schedules require a native backend deployment.`
  - `w7s.json` declares `schedules`, but the archive only contains static frontend output.
- `400 Invalid custom domain in CNAME file`
  - A `CNAME` file does not contain a valid hostname.
- `200 success` with `blockedCustomDomains`
  - The app deployed, but one or more `CNAME` hostnames were not attached because the TXT allowlist did not authorize the repo.
- `500 Unable to find a Cloudflare zone for custom domain`
  - W7S could not attach the Worker route for that hostname.
- `500 Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID`
  - Core Worker secrets are missing; deploy cannot publish native Workers.
