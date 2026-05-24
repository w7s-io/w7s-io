# w7s-io

W7S core runtime.

Codebase docs live in [`docs/`](./docs/README.md).

This repo contains the public W7S worker, deploy API, runtime router, and storage integrations:

- one Cloudflare Worker serves the public frontend and API;
- `POST /api/v1/deploy` accepts GitHub Actions repo zips;
- deployments are authorized by the GitHub token's access to the source repo;
- `worker/` or `backend/` apps publish to Workers for Platforms;
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
