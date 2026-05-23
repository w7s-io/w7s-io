# Cloudflare Operations

## GitHub Actions Deploy

The core deploy workflow is:

```text
.github/workflows/deploy.yml
```

It runs on:

- push to `main`;
- manual `workflow_dispatch`.

The workflow:

1. installs dependencies;
2. runs `npm run check`;
3. captures the Git branch and UTC deployment timestamp;
4. runs `npm run prepare:cloudflare`;
5. deploys with `npx wrangler deploy --config wrangler.generated.jsonc --secrets-file .wrangler/secrets.json`.

## Required GitHub Secrets

In `w7s-io/w7s-io`:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

`ACCOUNT_ID` is accepted as a fallback for `CLOUDFLARE_ACCOUNT_ID`.

The token must be able to:

- deploy Workers;
- manage Workers routes for `w7s.cloud`;
- read zones and manage Workers routes for any custom-domain zones W7S should attach;
- create/read KV namespaces;
- create/read R2 buckets;
- create/read Workers for Platforms dispatch namespaces;
- publish scripts into the dispatch namespace.

DNS record permissions are not required by the current deploy workflow because wildcard DNS and app custom-domain DNS are manual.

## Optional GitHub Variables

```text
W7S_ZONE_NAME                  default: w7s.cloud
W7S_DEPLOYMENTS_KV_NAME         default: w7s-io-deployments
W7S_STATIC_ASSETS_BUCKET        default: w7s-io-static-assets
W7S_DISPATCH_NAMESPACE          default: w7s-isolate
W7S_ATTACH_WILDCARD_ROUTE       default: false
W7S_COMPATIBILITY_DATE          default: 2026-05-23
```

Current cutover state uses:

```text
W7S_ATTACH_WILDCARD_ROUTE=true
```

## Generated Config

`scripts/prepare-cloudflare-config.mjs` writes:

```text
wrangler.generated.jsonc
.wrangler/secrets.json
```

These are intentionally ignored by git.

The generated config includes:

- `DEPLOYMENTS_KV`;
- `STATIC_ASSETS`;
- `DISPATCHER`;
- `w7s.cloud` custom domain;
- optional `*.w7s.cloud/*` route when `W7S_ATTACH_WILDCARD_ROUTE=true`;
- runtime vars such as `W7S_BASE_DOMAIN`, `W7S_WORKER_NAME`, `APP_COMMIT_ID`, `APP_DEPLOY_BRANCH`, and `APP_DEPLOYED_AT`;
- Worker secrets needed for user deploys.

## Wildcard Route Cutover

The public app URL model requires:

```text
*.w7s.cloud/* -> w7s-io Worker route
```

Before enabling it, the old runtime route must be gone. The prepare script proactively deletes a conflicting exact wildcard route if it is still assigned to another Worker and the token has route permissions.

## Wildcard DNS

The wildcard route is not enough by itself. Cloudflare DNS must also resolve org hosts.

Required DNS record in the `w7s.cloud` zone:

```text
Type: CNAME
Name: *
Target: w7s.cloud
Proxy status: Proxied
TTL: Auto
```

The current workflow does not manage this DNS record. Create it manually or use a separate DNS-scoped automation token.

If DNS is missing, requests fail before reaching W7S:

```text
curl: (6) Could not resolve host: <org>.w7s.cloud
```

## App Custom Domains

Deploy archives can declare one custom domain in a root `CNAME` file:

```text
CNAME
```

W7S also supports legacy/static-output CNAME locations:

```text
frontend/CNAME
frontend/dist/CNAME
dist/client/CNAME
dist/CNAME
build/CNAME
out/CNAME
```

Example file content:

```text
whereis.carlosguerrero.com
```

During deploy, W7S:

1. validates the hostname;
2. finds the matching Cloudflare zone available to the W7S token;
3. attaches a Worker route for `<hostname>/*` to the `w7s-io` Worker;
4. stores `custom_domain:v1:<hostname>` in KV.

W7S does not create DNS records. The domain owner must create DNS, normally:

```text
Type: CNAME
Name: whereis
Target: w7s.cloud
Proxy status: Proxied
TTL: Auto
```

## Resource Names

Default resource names:

```text
Worker: w7s-io
Dispatch namespace: w7s-isolate
KV namespace title: w7s-io-deployments
R2 bucket: w7s-io-static-assets
```

Native user Worker script names:

```text
<org>--<repo>--<environment>
```

Example:

```text
guerrerocarlos--w7s-io-demo--production
```
