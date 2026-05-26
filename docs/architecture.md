# Architecture

## Purpose

`w7s-io` is a small Cloudflare Worker that replaces the workflow-first runtime with a repo deploy core. Its job is to accept deploy archives, publish backend/frontend targets, store routing metadata, and route public requests to the deployed targets.

## Non-Goals

These are intentionally outside the core:

- workflow graph execution;
- `jsInterpreter`;
- built-in plugin globals;
- editor APIs;
- DB/migration control;
- telemetry UI;
- per-plugin config UI.

Those can be rebuilt later as W7S-deployed apps/components on top of this core.

## Main Components

- `src/worker.ts`
  - Hono entrypoint.
  - Registers `GET /health`, `GET /api/v1/health`, and `POST /api/v1/deploy`.
  - Health returns the deployed commit, branch, and deployment timestamp when available.
  - Sends all other requests through runtime routing, then falls back to the placeholder landing page.
- `src/api/deploy.ts`
  - Implements the deploy API.
  - Validates GitHub auth and archive shape.
  - Publishes native Workers and static frontend assets.
  - Stores one deployment record per org/repo/environment.
- `src/api/rpc.ts`
  - Implements internal backend-to-backend RPC.
  - Verifies caller tokens issued during deploy.
  - Dispatches authorized calls to target Workers through the dispatch namespace.
- `src/api/queues.ts`
  - Implements internal queue sends through RPC-style `w7s.internal` URLs.
  - Verifies caller tokens issued during deploy.
  - Sends messages to Cloudflare Queues owned by target deployments.
- `src/api/workflows.ts`
  - Implements internal workflow starts and status lookups through RPC-style `w7s.internal` URLs.
  - Verifies caller tokens issued during deploy.
  - Creates Cloudflare Workflow instances that dispatch to target app workflow consumer paths.
- `src/api/usage.ts`
  - Implements authenticated reads for per-app daily usage rollups.
  - Reuses GitHub repo access checks so only callers with repository access can read usage.
- `src/api/limits.ts`
  - Implements authenticated reads for effective per-app limit policies.
  - Does not expose write access; overrides are W7S-owned KV records.
- `src/analytics.ts`
  - Writes best-effort Workers Analytics Engine datapoints when `W7S_ANALYTICS` is bound.
- `src/api/analytics.ts`
  - Authenticates GitHub repository access and reads per-repo platform analytics from Workers Analytics Engine.
  - Keeps a stable low-cardinality schema for deploy, request, RPC, queue, schedule, and workflow events.
- `src/api/logs.ts`
  - Authenticates GitHub repository access and reads recent user Worker console/exception logs from KV.
- `src/logs.ts`
  - Implements the W7S `tail()` handler.
  - Maps Tail Worker script names back to deployed repositories and stores only mapped user Worker records.
  - Applies log write usage limits before persisting Tail Worker records.
- `src/usage.ts`
  - Writes best-effort daily usage counters into `DEPLOYMENTS_KV`.
  - Mirrors repo usage into owner-level and global aggregate daily rollups.
  - Tracks count, units, success, error, and last-seen time per metric.
- `src/usageLimits.ts`
  - Evaluates daily usage limits from a usage rollup.
  - Layers W7S-owned policy overrides from repo, owner aggregate, and global aggregate KV records.
  - Provides `checkUsageLimit(...)` metadata for hard enforcement hooks.
- `src/rateLimits.ts`
  - Applies short-window KV burst counters for high-risk cost paths.
- `src/usageEnforcement.ts`
  - Converts projected over-limit checks into HTTP `429` responses for public APIs.
  - Lets internal delivery paths skip queue, schedule, or workflow dispatch once delivery limits are exceeded.
- `src/cleanup.ts`
  - Runs from the scheduled handler to remove stale static assets, old usage records, expired suspensions, and stale dispatch Worker scripts.
- `src/deploy/archive.ts`
  - Reads zip archives into normalized file maps.
  - Strips common GitHub archive roots while preserving W7S app roots.
- `src/deploy/isolatePublisher.ts`
  - Publishes `backend/` or `worker/` apps into a Workers for Platforms dispatch namespace.
  - Supports local relative JS/TS module graphs only.
  - Adds a Tail Worker consumer to uploaded user Workers unless worker logs are disabled.
- `src/deploy/appManifest.ts`
  - Reads optional `w7s.json` manifests from deploy archives.
  - Validates storage binding declarations and runtime value names.
- `src/deploy/storageProvisioner.ts`
  - Creates or reuses per-app KV namespaces, R2 buckets, and D1 databases.
  - Applies D1 migrations declared by the app manifest.
  - Builds Worker upload metadata bindings for storage, Durable Objects, Hyperdrive, vars, and secrets.
  - Tracks DO classes that have already been created for a repo/environment.
- `src/deploy/queueProvisioner.ts`
  - Creates or reuses per-app Cloudflare Queues.
  - Configures the W7S core Worker as the Cloudflare Queue consumer.
- `src/deploy/rpcBindings.ts`
  - Creates the per-deployment RPC bearer token.
  - Adds `W7S_RPC`, `W7S_RPC_TOKEN`, and caller metadata bindings to native Workers.
- `src/deploy/queueBindings.ts`
  - Adds `W7S_QUEUE` and `W7S_QUEUE_TOKEN` bindings to native Workers.
- `src/deploy/workflowBindings.ts`
  - Adds `W7S_WORKFLOW` and `W7S_WORKFLOW_TOKEN` bindings to native Workers.
- `src/runtime/queueDelivery.ts`
  - Receives Cloudflare Queue batches in the W7S core Worker.
  - Dispatches queue batches to target app consumer routes.
- `src/runtime/scheduleDelivery.ts`
  - Receives Cloudflare scheduled events in the W7S core Worker.
  - Evaluates deployed app schedules and dispatches due jobs to target app routes.
- `src/runtime/workflowDelivery.ts`
  - Implements the core `W7SWorkflow` Cloudflare WorkflowEntrypoint.
  - Runs a durable step that dispatches each workflow instance to the target app route.
- `src/deploy/staticPublisher.ts`
  - Publishes detected static frontend output files to R2.
  - Stores a static manifest in KV.
- `src/runtime/router.ts`
  - Resolves org/repo requests.
  - Serves exact static assets first.
  - Dispatches to native Workers.
  - Falls back to `index.html` for static SPA routes.
- `src/storage/deployments.ts`
  - Defines KV keys and persisted deployment/static manifest shapes.
- `scripts/prepare-cloudflare-config.mjs`
  - GitHub Actions helper that generates `wrangler.generated.jsonc`.
  - Creates or finds KV/R2/dispatch namespace resources.
  - Copies deploy metadata from the GitHub Actions environment into Worker vars.
  - Attaches routes when requested by repo variables.

## Request Flow

```text
POST /api/v1/deploy
  -> verify GitHub token can access x-github-repository
  -> unzip archive
  -> read optional w7s.json and encoded runtime values
  -> detect backend/ or worker/
  -> provision declared app storage and Worker bindings for native Workers
  -> publish native Worker to dispatch namespace
  -> detect static frontend output
  -> upload static files to R2
  -> store deployment record in KV
  -> write deploy analytics when configured
  -> record deploy usage rollup
```

```text
GET https://<org>.w7s.cloud/<repo>/<path>
  -> resolve org from host
  -> resolve repo from first path segment, or same-name org root repo
  -> load deployment record from KV
  -> serve exact static asset if present
  -> dispatch to native Worker if present
  -> if native Worker returns 404/405, serve static SPA fallback if present
  -> write request analytics when configured
```

```text
GET/POST env.W7S_RPC.fetch("/api/v1/rpc/<owner>/<repo>/<path>")
  -> require caller bearer token from W7S_RPC_TOKEN
  -> load caller deployment in x-w7s-rpc-environment
  -> verify token hash from the caller deployment record
  -> load target deployment in the same environment
  -> allow same-owner calls by default
  -> require target w7s.json rpc.allow for cross-owner calls
  -> dispatch to the target Worker with caller identity headers
  -> write RPC analytics when configured
  -> record RPC usage rollup for the caller repo
```

```text
POST env.W7S_QUEUE.fetch("/api/v1/queues/<owner>/<repo>/<queue>")
  -> require caller bearer token from W7S_QUEUE_TOKEN
  -> load caller deployment in x-w7s-queue-environment
  -> verify token hash from the caller deployment record
  -> load target deployment in the same environment
  -> require target w7s.json queues declaration
  -> allow same-owner sends by default
  -> require target w7s.json queue.allow for cross-owner sends
  -> send a Cloudflare Queue message
  -> receive the batch in W7S core and dispatch to the target consumer route
  -> write queue send and delivery analytics when configured
  -> record queue send usage for the caller and delivery usage for the target
```

```text
POST env.W7S_WORKFLOW.fetch("/api/v1/workflows/<owner>/<repo>/<workflow>")
  -> require caller bearer token from W7S_WORKFLOW_TOKEN
  -> load caller deployment in x-w7s-workflow-environment
  -> verify token hash from the caller deployment record
  -> load target deployment in the same environment
  -> require target w7s.json workflows declaration
  -> allow same-owner starts by default
  -> require target w7s.json workflow.allow for cross-owner starts
  -> create a Cloudflare Workflow instance through the W7S core binding
  -> W7SWorkflow dispatches a durable step to the target app workflow route
  -> write workflow create and delivery analytics when configured
  -> record workflow create usage for the caller and delivery usage for the target
```

```text
Cloudflare scheduled event
  -> W7S core runs once per minute
  -> scan deployed schedule mappings
  -> match five-field cron expressions against the scheduled minute
  -> acquire a short KV lock for schedule/time
  -> dispatch due jobs to native Worker schedule paths
  -> write schedule delivery analytics when configured
  -> record schedule delivery usage for the target repo
  -> acquire a separate hourly Cloudflare usage lock
  -> sync direct resource analytics into usage_cf_hourly:v1:* records
  -> merge hourly usage into daily rollups and suspend exceeded apps
```

```text
GET /api/v1/usage/<owner>/<repo>?date=YYYY-MM-DD
  -> require GitHub bearer token
  -> verify token can access owner/repo through GitHub
  -> load usage_daily:v1:<date>:<environment>:<owner>:<repo> from KV
  -> return an empty rollup if no usage exists for the date
  -> load effective limit policy from default + W7S-owned KV overrides
  -> evaluate daily limits and include warning metadata
```

```text
GET /api/v1/limits/<owner>/<repo>
  -> require GitHub bearer token
  -> verify token can access owner/repo through GitHub
  -> load effective limit policy from default + W7S-owned KV overrides
  -> return policies and lookup metadata
```

## Compatibility Choices

- `worker/` and `backend/` are both accepted as native backend roots.
- `dist/server` is accepted for Cloudflare/Vite SSR build output.
- If both roots are present, `worker/` entrypoints are preferred because their candidates are listed first.
- `frontend/dist`, `dist/client`, `dist`, `build`, and `out` are treated as already-built frontend output.
- `dist/client` can be asset-only when paired with a native `dist/server` Worker, which covers TanStack Start and similar SSR builds.
- W7S does not install dependencies or run user builds during deploy.
- Bare package imports inside native backend code are not supported by deploy-time publishing. Repos should upload bundled code or use relative local modules only.
- Per-app storage is stable across redeploys for the same repository and environment. New commits reuse the same managed KV/R2/D1 resources.
- Durable Object apps use stable script names for the same repository and environment. W7S auto-creates new SQLite-backed classes, but it does not automate DO renames, transfers, or deletes yet.
- Hyperdrive bindings use user-provided Cloudflare Hyperdrive config IDs. W7S does not create or rotate Hyperdrive configs yet.
- Backend-to-backend RPC is routed through the core Worker service binding. It does not expose target Workers directly, and cross-owner calls are opt-in through the target app's `w7s.json`.
- Queues are app-owned, environment-scoped Cloudflare Queues. Apps send through `W7S_QUEUE`; W7S core owns queue provisioning and delivery dispatch, caps message size, and creates consumers with bounded batch/retry settings.
- Schedules are environment-scoped path consumers. W7S core owns the Cloudflare cron trigger and dispatches due jobs to native Workers.
- Workflows are app-declared, environment-scoped path consumers. W7S core owns the Cloudflare Workflow definition and starts instances on behalf of apps.
- Analytics Engine is an optional W7S-core binding. It is for platform observability first; app-visible analytics bindings can be added later.
- The analytics API exposes summaries, time buckets, and recent platform events.
- The logs API exposes recent app `console.*` output, uncaught exceptions, and non-OK Worker outcomes captured through Tail Worker events.
- Usage rollups are stored in `DEPLOYMENTS_KV` with read-modify-write updates. Repo rollups are mirrored into owner/global aggregates, and direct Cloudflare resource usage is synced hourly from Cloudflare analytics. These are enough for free-tier protection, but not atomic billing-grade counters.
- `checkUsageLimit(...)` reports whether a future request would exceed policy. Public runtime, deploy, RPC, queue-send, and workflow-start paths return HTTP `429`; internal queue, schedule, and workflow delivery paths skip dispatch when their delivery metric would exceed policy. `src/rateLimits.ts` adds minute/hour burst protection before daily counters are reached.
