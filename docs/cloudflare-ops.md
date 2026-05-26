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
5. deploys with `npx wrangler deploy --config wrangler.generated.jsonc --secrets-file .wrangler/secrets.json`;
6. runs `npm run reconcile:cloudflare-routes`.

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
- create/read/query D1 databases;
- create/read Workers for Platforms dispatch namespaces;
- publish scripts into the dispatch namespace.
- deploy Cloudflare Workflows attached to the core Worker.

DNS record permissions are not required by the current deploy workflow because wildcard DNS and app custom-domain DNS are manual.

## Optional GitHub Variables

```text
W7S_ZONE_NAME                  default: w7s.cloud
W7S_DEPLOYMENTS_KV_NAME         default: w7s-io-deployments
W7S_STATIC_ASSETS_BUCKET        default: w7s-io-static-assets
W7S_DISPATCH_NAMESPACE          default: w7s-isolate
W7S_ANALYTICS_DATASET           optional Analytics Engine dataset name
W7S_WORKFLOW_NAME               default: w7s-workflows
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
- `W7S_WORKFLOWS`;
- `W7S_ANALYTICS`, when `W7S_ANALYTICS_DATASET` is set;
- runtime vars such as `W7S_BASE_DOMAIN`, `W7S_WORKER_NAME`, `APP_COMMIT_ID`, `APP_DEPLOY_BRANCH`, and `APP_DEPLOYED_AT`;
- a per-minute core Cron Trigger used to dispatch app-declared schedules;
- Worker secrets needed for user deploys.

Routes are reconciled after `wrangler deploy` instead of being managed by the generated Wrangler config. This prevents core deploys from deleting W7S app custom-domain routes such as `community.w7s.io/*`.

## Wildcard Route Cutover

The public app URL model requires:

```text
*.w7s.cloud/* -> w7s-io Worker route
```

Before enabling it, any conflicting route owned by another Worker must be gone. The post-deploy route reconciler replaces conflicting exact routes when the token has route permissions.

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
3. reads the optional TXT allowlist at `_w7s.<zone>`;
4. checks whether the hostname is already mapped in KV;
5. attaches a Worker route for `<hostname>/*` to the `w7s-io` Worker when the claim is allowed;
6. stores `custom_domain:v1:<hostname>` in KV.

The first repo to claim a hostname is allowed without a TXT record. The deploy response includes a warning recommending a TXT allowlist:

```text
Name: _w7s.carlosguerrero.com
Value: guerrerocarlos/whereis
```

Once the TXT record exists, W7S treats it as authoritative for that zone. The value is comma-separated:

```text
guerrerocarlos
guerrerocarlos,omattic
guerrerocarlos/whereis,omattic
```

An owner token, such as `guerrerocarlos`, authorizes every repo under that owner. A repo token, such as `guerrerocarlos/whereis`, authorizes only that repo. If two repos claim the same hostname and no TXT record exists, the existing KV mapping keeps ownership until the domain owner adds TXT authorization for the new repo.

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
Workflow: w7s-workflows
```

Native user Worker script names:

```text
<org>--<repo>--<environment>--<commit>
```

Example:

```text
guerrerocarlos--w7s-io-demo--production--abc123
```

Managed app storage names are generated from:

```text
w7s-<environment>-<org>-<repo>-<kind>-<binding>
```

These resources are stored in `DEPLOYMENTS_KV` and reused across redeploys for the same repository/environment.

## Analytics Engine

Set `W7S_ANALYTICS_DATASET` as a GitHub repo variable to add this binding to the generated Wrangler config:

```json
{
  "binding": "W7S_ANALYTICS",
  "dataset": "w7s_platform_events"
}
```

The core writes one Analytics Engine datapoint for successful deploys and for runtime request, RPC, queue send, queue delivery, and schedule delivery paths. Missing or failing analytics writes are ignored so observability cannot affect app traffic.

Datapoint schema:

```text
index1  repository, or w7s-core

blob1   event
blob2   repository
blob3   environment
blob4   org slug
blob5   repo slug
blob6   outcome
blob7   source
blob8   target repository
blob9   method

double1 count
double2 HTTP status
double3 duration in milliseconds
```

Current event names:

```text
deploy
runtime_request
runtime_showcase
rpc
queue_send
queue_delivery
schedule_delivery
workflow_create
workflow_delivery
```

## Workflows

The generated config always attaches one Cloudflare Workflow to the core Worker:

```json
{
  "name": "w7s-workflows",
  "binding": "W7S_WORKFLOWS",
  "class_name": "W7SWorkflow"
}
```

Use `W7S_WORKFLOW_NAME` to change the Cloudflare Workflow resource name. User apps do not receive direct Workflow bindings. Instead, every native backend receives:

```text
W7S_WORKFLOW
W7S_WORKFLOW_TOKEN
```

`W7S_WORKFLOW` is a service binding to the W7S core Worker. The core verifies the caller token, creates a workflow instance through `W7S_WORKFLOWS`, and the `W7SWorkflow` class dispatches a durable step to the target app's declared workflow path.
