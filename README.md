# w7s-io

Minimal W7S core runtime.

Full takeover docs live in [`docs/`](./docs/README.md).

This repo is the greenfield replacement core for W7S. It keeps the platform small:

- one Cloudflare Worker serves the public frontend and API;
- `POST /api/v1/deploy` accepts GitHub Actions repo zips;
- deployments are authorized by the GitHub token's access to the source repo;
- `worker/` or `backend/` apps publish to Workers for Platforms;
- `frontend/dist` assets publish to R2 and are served from `https://<org>.w7s.cloud/<repo>/*`.

The old workflow interpreter and hard-coded plugin bridge are intentionally not part of this core. They can be rebuilt later as W7S apps/components on top of this deploy surface.

## Deploy API

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

Set `W7S_ATTACH_WILDCARD_ROUTE=true` only when `*.w7s.cloud/*` has been removed from the old runtime Worker, otherwise Cloudflare rejects the deploy with a duplicate route error.

Wildcard DNS is intentionally managed manually. Before enabling the wildcard Worker route, create a proxied Cloudflare DNS record:

- Type: `CNAME`
- Name: `*`
- Target: `w7s.cloud`
- Proxy status: proxied
