# W7S Cloudflare Platform Roadmap

## Purpose

W7S should expose useful Cloudflare platform features as small, repo-declared primitives that run on top of the W7S deploy core. The core should stay focused on deploy, routing, provisioning, and internal dispatch. Higher-level products can be built as W7S apps.

## Current Baseline

- GitHub Actions deploy archives through `w7s-io/w7s-cloud@v1`.
- Native backends deploy into a Workers for Platforms dispatch namespace.
- Static assets deploy to R2 and route through the W7S core Worker.
- `w7s.json` can declare KV, R2, D1, Durable Objects, Hyperdrive, queues, schedules, workflows, vars, secrets, RPC allowlists, queue allowlists, and workflow allowlists.
- RPC, Queue sends, and Workflow starts use internal service bindings because W7S app Workers are dispatch-namespace scripts, not ordinary account-level Workers.
- W7S core can optionally write platform metrics to Workers Analytics Engine when `W7S_ANALYTICS_DATASET` is configured.
- W7S core stores best-effort daily usage rollups in `DEPLOYMENTS_KV` and exposes them with effective limit warnings through `GET /api/v1/usage/<owner>/<repo>`.

## Implementation Order

1. **Cron schedules**
   - Status: implemented as the first platform roadmap primitive.
   - Manifest:
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
   - Core receives a per-minute Cloudflare scheduled event, evaluates app schedules, and dispatches due jobs to native backend HTTP paths.
   - Delivery payload:
     ```json
     {
       "schedule": "*/5 * * * *",
       "scheduledTime": "2026-05-25T12:00:00.000Z",
       "repository": "owner/repo",
       "environment": "production"
     }
     ```
   - Headers:
     - `x-w7s-schedule: 1`
     - `x-w7s-schedule-cron`
     - `x-w7s-schedule-time`

2. **Durable Objects**
   - Status: implemented as the second platform roadmap primitive.
   - Goal: realtime rooms, locks, counters, sessions, WebSocket hubs, and stateful coordination.
   - Manifest:
     ```json
     {
       "bindings": {
         "durableObjects": [
           {
             "binding": "ROOMS",
             "className": "Room"
           }
         ]
       }
     }
     ```
   - Native Workers with Durable Objects are uploaded with a stable per-repo/environment script name so DO state survives redeploys.
   - W7S uploads `durable_object_namespace` bindings for classes exported by the app Worker.
   - W7S automatically creates SQLite-backed DO classes the first time it sees them.
   - Renames, transfers, and deletes are intentionally not automated yet.

3. **Hyperdrive**
   - Status: implemented as a user-provided binding primitive.
   - Goal: let apps use external Postgres from Workers.
   - Manifest:
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
   - W7S uploads `hyperdrive` Worker bindings using user-provided Cloudflare Hyperdrive IDs.
   - Managed Hyperdrive creation can come later.

4. **Analytics Engine**
   - Status: implemented as optional W7S-internal writes.
   - Goal: collect per-app deploy, request, RPC, queue, schedule, and platform usage metrics.
   - Set `W7S_ANALYTICS_DATASET` to add the core `W7S_ANALYTICS` binding.
   - Datapoints are written for deploy success, runtime requests, deploy-help showcases, RPC dispatches, queue sends, queue deliveries, and schedule deliveries.
   - Schema uses the repository as the Analytics Engine index, blobs for dimensions, and doubles for count/status/duration.
   - App-visible analytics bindings can be added later.

5. **Workflows**
   - Status: implemented as a W7S-core bridge.
   - Goal: durable multi-step jobs with sleeps, retries, and long-running orchestration.
   - First phase uses a W7S-core bridge, similar to queues, because app Workers are dispatch-namespace scripts.
   - Manifest:
     ```json
     {
       "workflows": [
         {
           "name": "process-order",
           "path": "/_w7s/workflows/process-order"
         }
       ]
     }
     ```
   - Native backends receive `W7S_WORKFLOW` and `W7S_WORKFLOW_TOKEN`.
   - Starts use `/api/v1/workflows/<owner>/<repo>/<workflow>`.
   - W7S core creates a Cloudflare Workflow instance and dispatches a durable step to the target backend path.
   - Revisit direct app integration if Cloudflare exposes a direct WFP-compatible consumer model.

6. **Usage accounting and limits**
   - Status: basic rollups, effective policy reads, warning thresholds, and hard daily enforcement are implemented.
   - Goal: make platform usage visible before enabling costly primitives.
   - Current API:
     ```text
     GET /api/v1/usage/<owner>/<repo>?date=YYYY-MM-DD
     ```
   - GitHub bearer tokens must have access to the target repo.
   - Current rollups are KV read-modify-write counters for deploy, RPC, queue, schedule, and workflow usage.
   - Public deploy, RPC, queue-send, and workflow-start paths return HTTP `429` when projected usage exceeds the effective daily limit.
   - Internal queue, schedule, and workflow delivery paths skip dispatch when their delivery metric would exceed policy.
   - Effective policy reads are available at `GET /api/v1/limits/<owner>/<repo>`.
   - W7S-owned KV overrides can target owner, owner/environment, repo, or repo/environment scopes.
   - `checkUsageLimit(...)` reports whether projected usage would exceed policy and feeds the hard enforcement helper.
   - Next phase should upgrade the counter store beyond KV read-modify-write rollups before treating limits as billing-grade.

7. **AI, Vectorize, and AI Gateway**
   - Goal: support AI apps, embeddings, semantic search, and controlled LLM usage.
   - Add only after usage/accounting can enforce safe platform limits.

8. **Turnstile and Email Routing**
   - Lower priority app security and inbound email integrations.
   - Turnstile can expose managed site keys/secrets.
   - Email Routing likely needs a core bridge that dispatches inbound email events to app paths.

## Design Rules

- Prefer simple `w7s.json` declarations over raw Cloudflare config.
- Keep same-owner app communication easy by default; require explicit allowlists for cross-owner access.
- Reuse existing dispatch namespace infrastructure unless Cloudflare supports direct WFP integration.
- Scope managed resources by environment, owner, repo, and binding/job name.
- Avoid adding UI requirements to the core. APIs and metadata should make UI apps possible later.

## Near-Term Acceptance Criteria

- Cron schedules are declared in `w7s.json`, persisted in deployment records, and dispatched through the core scheduled handler.
- Stale schedule mappings are removed on redeploy.
- Static-only deployments cannot declare schedules.
- Docs explain schedule declarations, payloads, headers, and operational limits.
- Tests cover cron matching, manifest/deploy validation, mapping replacement, and scheduled dispatch.
- Durable Objects are declared in `w7s.json`, uploaded as Worker metadata bindings, and covered by deploy tests.
- Durable Object apps use stable script names; non-DO backends keep commit-specific script names.
- Hyperdrive bindings are declared in `w7s.json`, uploaded as Worker metadata bindings, and covered by deploy tests.
- Analytics Engine is optional in the generated Wrangler config and covered by deploy, runtime, RPC, queue, schedule, and helper tests.
- Workflows are declared in `w7s.json`, exposed through `W7S_WORKFLOW`, backed by one W7S-core Cloudflare Workflow, and covered by deploy, API, and delivery tests.
- Usage rollups are stored in `DEPLOYMENTS_KV`, exposed through an authenticated API, and covered by helper/API tests.
