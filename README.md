# w7s-io

W7S core runtime.

Codebase docs live in [`docs/`](./docs/README.md).

This repo contains the public W7S worker, deploy API, runtime router, and storage integrations:

- one Cloudflare Worker serves the public frontend and API;
- `POST /api/v1/deploy` accepts GitHub Actions repo zips;
- deployments are authorized by the GitHub token's access to the source repo;
- `worker/` or `backend/` apps publish to Workers for Platforms;
- Cloudflare-style SSR output in `dist/server` plus assets in `dist/client` is supported;
- `w7s.json` can declare per-app KV, R2, D1, queues, schedules, vars, and secrets for native backends;
- native backends receive internal `W7S_RPC` and `W7S_QUEUE` service bindings for backend-to-backend calls and queue sends;
- static frontend assets publish to R2 and are served from `https://<org>.w7s.cloud/<repo>/*`.
- same-name repos such as `github.com/<org>/<org>` can serve directly from `https://<org>.w7s.cloud/*`.
- non-production branches serve from `https://<branch>--<org>.w7s.cloud/<repo>/*`.
- `CNAME` can declare custom domains for a deployment, with optional `_w7s.<zone>` TXT allowlists for ownership control.

## Deploy API

Health is available at both `GET /health` and `GET /api/v1/health`. GitHub Actions deploys expose the deployed commit, branch, and UTC deployment timestamp in the health response.

```sh
curl -X POST "https://w7s.cloud/api/v1/deploy" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "x-github-repository: owner/repo" \
  -H "x-github-sha: $GITHUB_SHA" \
  -H "x-github-branch: main" \
  -H "content-type: application/zip" \
  --data-binary "@repo.zip"
```

Optional environment override:

- query: `?environment=staging`
- header: `x-w7s-environment: staging`

Without an override, `main` and `master` deploy to `production`; other branches deploy to a sanitized branch environment.

Production deployments are served from:

```text
https://<org>.w7s.cloud/<repo>/
```

Non-production branch deployments are served from:

```text
https://<branch-name>--<org>.w7s.cloud/<repo>/
```

## Repository Layout

Native backend:

```text
worker/index.ts
```

or:

```text
backend/index.ts
```

or Cloudflare/Vite SSR output:

```text
dist/server/index.js
dist/client/assets/app.js
```

Frontend:

```text
dist/index.html
dist/assets/app.js
```

or:

```text
dist/client/index.html
dist/client/assets/app.js
```

or:

```text
frontend/dist/index.html
frontend/dist/assets/app.js
```

Both may be present in the same deploy archive.

Optional app manifest:

```json
{
  "bindings": {
    "kv": ["CACHE"],
    "r2": ["FILES"],
    "d1": [{ "binding": "DB", "migrations": "migrations" }]
  },
  "queues": ["jobs"],
  "schedules": [
    {
      "cron": "*/5 * * * *",
      "path": "/_w7s/schedules/sync"
    }
  ],
  "vars": ["GOOGLE_CLIENT_ID"],
  "secrets": ["GOOGLE_CLIENT_SECRET"],
  "queue": {
    "allow": ["w7s-io", "guerrerocarlos/notepad"]
  },
  "rpc": {
    "allow": ["w7s-io", "guerrerocarlos/notepad"]
  }
}
```

Managed storage, queues, and schedules are scoped by repository and environment, so a production deploy and a feature-branch deploy receive separate durable resources. D1 migration files are applied once in sorted order and tracked in the app database.

Native backends automatically receive `W7S_RPC`, `W7S_RPC_TOKEN`, `W7S_OWNER`, `W7S_REPO`, `W7S_REPOSITORY`, and `W7S_ENVIRONMENT`. Same-owner apps can call each other by default. Cross-owner calls are accepted only when the target deployment's `w7s.json` lists the caller owner or exact `owner/repo` in `rpc.allow`.

Native backends also receive `W7S_QUEUE` and `W7S_QUEUE_TOKEN`. Queue messages are sent with RPC-style internal URLs:

```ts
await env.W7S_QUEUE.fetch(
  "https://w7s.internal/api/v1/queues/w7s-io/example-worker/jobs",
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.W7S_QUEUE_TOKEN}`,
      "content-type": "application/json",
      "x-w7s-queue-caller": env.W7S_REPOSITORY,
      "x-w7s-queue-environment": env.W7S_ENVIRONMENT
    },
    body: JSON.stringify({ type: "work" })
  }
);
```

## Required Cloudflare Bindings

- `DISPATCHER`: Workers for Platforms dispatch namespace
- `DEPLOYMENTS_KV`: deployment metadata and static manifests
- `STATIC_ASSETS`: R2 bucket for deployed frontend assets
- `CLOUDFLARE_API_TOKEN`: secret with dispatch namespace publish access
- `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account id

## GitHub Deploy

The push workflow generates a temporary Wrangler config from Cloudflare API state.

Required secrets:

- `CLOUDFLARE_API_TOKEN`
- `ACCOUNT_ID` or `CLOUDFLARE_ACCOUNT_ID`

Optional repo variables:

- `W7S_ZONE_NAME`, default `w7s.cloud`
- `W7S_DEPLOYMENTS_KV_NAME`, default `w7s-io-deployments`
- `W7S_STATIC_ASSETS_BUCKET`, default `w7s-io-static-assets`
- `W7S_DISPATCH_NAMESPACE`, default `w7s-isolate`
- `W7S_ATTACH_WILDCARD_ROUTE`, default `false`

Set `W7S_ATTACH_WILDCARD_ROUTE=true` only when this worker should attach the `*.w7s.cloud/*` route. Cloudflare rejects the deploy if another worker already owns that route.

Wildcard DNS is intentionally managed manually. Before enabling the wildcard Worker route, create a proxied Cloudflare DNS record:

- Type: `CNAME`
- Name: `*`
- Target: `w7s.cloud`
- Proxy status: proxied

Custom-domain DNS is also manual. A root `CNAME` file can claim `app.example.com`; create DNS pointing that host to `w7s.cloud`. Add TXT `_w7s.example.com` with values like `owner` or `owner/repo` to restrict which GitHub repos can use hostnames on that zone.
