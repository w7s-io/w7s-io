# Agent Handoff

## Current State

As of the latest docs update:

- `w7s-io` is deployed from GitHub Actions on push to `main`.
- `W7S_ATTACH_WILDCARD_ROUTE=true` is set in GitHub repo variables.
- The Worker route `*.w7s.cloud/*` is attached by the deploy workflow.
- Wildcard DNS is expected to be managed manually.
- `backend/`, `worker/`, and static frontend deploys are supported.
- Native backends can declare per-app KV, R2, D1, Durable Objects, Hyperdrive, queues, schedules, workflows, vars, and secrets in `w7s.json`.
- Native backends receive `W7S_RPC`, `W7S_RPC_TOKEN`, and W7S metadata vars for backend-to-backend RPC.
- Same-owner RPC is allowed by default; cross-owner RPC requires the target app to list allowed owners or repos in `w7s.json` under `rpc.allow`.
- Native backends receive `W7S_QUEUE` and `W7S_QUEUE_TOKEN` for queue sends through `/api/v1/queues/<owner>/<repo>/<queue>`.
- Same-owner queue sends are allowed by default; cross-owner sends require the target app to list allowed owners or repos in `w7s.json` under `queue.allow`.
- Native backends receive `W7S_WORKFLOW` and `W7S_WORKFLOW_TOKEN` for starting workflow instances through `/api/v1/workflows/<owner>/<repo>/<workflow>`.
- Same-owner workflow starts are allowed by default; cross-owner starts require the target app to list allowed owners or repos in `w7s.json` under `workflow.allow`.
- Schedules are declared with `schedules` in `w7s.json`; W7S core runs a per-minute Cloudflare cron trigger and dispatches due schedules to native backend paths.
- Workflows are declared with `workflows` in `w7s.json`; W7S core owns one Cloudflare Workflow and dispatches workflow instances to native backend paths.
- Durable Objects are declared with `bindings.durableObjects` in `w7s.json`; W7S uploads the binding metadata and initial SQLite-backed class migrations.
- Hyperdrive bindings are declared with `bindings.hyperdrive` in `w7s.json`; W7S uploads user-provided Hyperdrive config IDs as Worker bindings.
- If `W7S_ANALYTICS_DATASET` is configured, the core writes Workers Analytics Engine datapoints for deploys, runtime requests, RPC, queues, schedules, and workflows.
- `/api/v1/analytics/<owner>/<repo>` reads those Analytics Engine datapoints for authorized repo users.
- Native user Worker uploads include a Tail Worker consumer pointing at W7S unless disabled; `/api/v1/logs/<owner>/<repo>` reads captured console, exception, and outcome records for authorized repo users.
- The core stores per-app daily usage rollups in `DEPLOYMENTS_KV`, mirrors repo usage into owner/global aggregate rollups, syncs direct Cloudflare resource usage hourly, and exposes repo usage through `GET /api/v1/usage/<owner>/<repo>`.
- Effective limit policies are exposed through `GET /api/v1/limits/<owner>/<repo>` and can be overridden only with W7S-owned KV policy records.
- W7S operators can manage limit policy KV records with `npm run limits:get`, `npm run limits:set`, and `npm run limits:delete`.
- `checkUsageLimit(...)` returns hard-enforcement metadata. Public runtime, deploy, RPC, queue-send, and workflow-start paths return HTTP `429` when the request would exceed the effective daily limit.
- Short-window burst guards protect deploys, runtime requests, RPC, queues, schedules, workflows, and log ingestion.
- Hourly Cloudflare usage collection stores `usage_cf_hourly:v1:*` and can write `app_limit_state:v1:*` to suspend apps until the next UTC day.
- The scheduled handler also cleans stale static assets, stale dispatch Worker scripts, expired app suspension states, and old usage records.
- Optional Telegram manager notifications are sent when `W7S_TELEGRAM_BOT_TOKEN` and `W7S_TELEGRAM_CHAT_ID` are configured. Events cover deploy success/warning/error, app suspension, and hourly usage collection failures.
- Root `CNAME` files can attach app custom-domain routes when the W7S token can manage that Cloudflare zone.
- Custom domains use soft TXT verification: the first claim works without TXT, `_w7s.<zone>` becomes an owner/repo allowlist when present, and hostname conflicts require TXT authorization.
- Empty org roots such as `https://sadasant.w7s.cloud/` show deploy-help HTML instead of a plain 404.
- The demo repo `guerrerocarlos/w7s-io-demo` deploys successfully through the reusable deploy action.
- The example repo `w7s-io/example-fullstack-ts` exists as a reusable fullstack TypeScript starter.

## Do Not Reintroduce

Avoid pulling old `w7s-cloud` concepts into this core unless explicitly requested:

- editor APIs;
- workflow CRUD;
- interpreter snapshots;
- core-imported plugins;
- D1 workflow schema;
- telemetry UI.

The point of this repo is to keep the core deploy/routing plane small.

## Known Limitations

- W7S does not build user repos. CI must upload ready-to-run files.
- Native backend deploy supports only relative local imports.
- Managed storage is provisioned per repository/environment and reused across redeploys.
- Durable Object apps use stable per-repository/environment script names so DO state survives redeploys. DO class renames, transfers, and deletes are not automated yet.
- Hyperdrive config creation and credential rotation are not managed by W7S yet. Apps must provide existing Cloudflare Hyperdrive IDs.
- Analytics Engine is currently W7S-core platform event analytics. User app analytics bindings are not exposed yet.
- User Worker logs are captured from Tail Worker events after a user Worker has been redeployed with the tail consumer metadata.
- Usage rollups and burst guards are approximate KV counters, and Cloudflare-polled direct binding metrics are delayed by the hourly collector. Limits are enforced for free-tier protection, but they are not atomic billing-grade accounting. There is no public policy write API yet.
- Queues are provisioned per repository/environment and delivered through W7S core to app HTTP consumer routes.
- Schedules are delivered through W7S core to app HTTP consumer routes. They currently use best-effort KV locks to avoid duplicate schedule/time dispatches.
- Workflows are delivered through W7S core to app HTTP consumer routes. The first implementation is a durable one-step dispatch with retries, not a user-defined multi-step WorkflowEntrypoint inside the app Worker.
- Static hosting supports `frontend/dist`, `dist/client`, `dist`, `build`, and `out`.
- Custom-domain DNS is manual; W7S only stores the host mapping and attaches a Worker route.
- W7S custom-domain verification is soft. A missing TXT record allows the first claim, so serious custom-domain users should add `_w7s.<zone>` with a GitHub owner or `owner/repo` allowlist.
- RPC currently uses a low-level `env.W7S_RPC.fetch(...)` convention. There is no typed client package yet.
- Queues currently use a low-level `env.W7S_QUEUE.fetch(...)` convention. There is no typed queue client package yet.
- Workflows currently use a low-level `env.W7S_WORKFLOW.fetch(...)` convention. There is no typed workflow client package yet.
- No rollback UI or deployment history API yet.
- The analytics API exposes recent platform events; the logs API exposes recent user Worker `console.*`/exception records.
- Wildcard DNS is manual.

## Common Next Tasks

Good near-term tasks:

- add an API to list/get deployment records;
- expose deploy history per org/repo/environment;
- improve native backend bundling support;
- add delete/rollback for deployed user Workers;
- add typed RPC/queue clients and first-party plugin conventions on top of `W7S_RPC` and `W7S_QUEUE`;
- add structured deploy logs;
- add Analytics Engine query APIs and dashboards;
- upgrade usage accounting beyond KV read-modify-write rollups before treating limits as billing-grade;
- add end-to-end tests that deploy a demo archive against a staging Worker.

## Important Repos

```text
Core:         https://github.com/w7s-io/w7s-io
Legacy:       https://github.com/w7s-io/w7s-cloud
Deploy action:https://github.com/w7s-io/w7s-cloud/tree/main/.github/actions/w7s-deploy
Example:      https://github.com/w7s-io/example-fullstack-ts
Demo:         https://github.com/guerrerocarlos/w7s-io-demo
```

## Takeover Checklist

When starting work:

1. Read [Architecture](./architecture.md).
2. Run `git status --short --branch`.
3. Run `npm run check`.
4. Check latest deploy run:

   ```sh
   gh run list --repo w7s-io/w7s-io --limit 5
   ```

5. Check health:

   ```sh
   curl -fsS https://w7s.cloud/health
   curl -fsS https://w7s.cloud/api/v1/health
   ```

   A current GitHub Actions deploy should report `commitId`, `branch`, and `deployedAt`.

6. If working on public org routes, confirm DNS for the test org host resolves before debugging app code.
