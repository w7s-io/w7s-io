# W7S Cloudflare Platform Roadmap

## Purpose

W7S should expose useful Cloudflare platform features as small, repo-declared primitives that run on top of the W7S deploy core. The core should stay focused on deploy, routing, provisioning, and internal dispatch. Higher-level products can be built as W7S apps.

## Current Baseline

- GitHub Actions deploy archives through `w7s-io/w7s-cloud@v1`.
- Native backends deploy into a Workers for Platforms dispatch namespace.
- Static assets deploy to R2 and route through the W7S core Worker.
- `w7s.json` can declare KV, R2, D1, queues, schedules, vars, secrets, RPC allowlists, and queue allowlists.
- RPC and Queue sends use internal service bindings because W7S app Workers are dispatch-namespace scripts, not ordinary account-level Workers.

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
   - Goal: realtime rooms, locks, counters, sessions, WebSocket hubs, and stateful coordination.
   - Manifest sketch:
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
   - The first version should bind app-exported Durable Object classes during Worker upload. Migration ergonomics need a careful design before public release.

3. **Hyperdrive**
   - Goal: let apps use external Postgres from Workers.
   - Manifest sketch:
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
   - Start with user-provided Cloudflare Hyperdrive IDs. Managed creation can come later.

4. **Analytics Engine**
   - Goal: collect per-app deploy, request, RPC, queue, schedule, and platform usage metrics.
   - First phase should be W7S-internal writes for observability and billing.
   - App-visible analytics bindings can be added later.

5. **Workflows**
   - Goal: durable multi-step jobs with sleeps, retries, and long-running orchestration.
   - Prefer a W7S-core bridge first, similar to queues, because app Workers are dispatch-namespace scripts.
   - Revisit direct app integration if Cloudflare exposes a direct WFP-compatible consumer model.

6. **AI, Vectorize, and AI Gateway**
   - Goal: support AI apps, embeddings, semantic search, and controlled LLM usage.
   - Add only after the usage/accounting story is clear.

7. **Turnstile and Email Routing**
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
