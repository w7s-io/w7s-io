# W7S Gaps

This file tracks the main known gaps after the current deploy core, runtime routing, storage bindings, RPC, queues, schedules, Durable Objects, Hyperdrive, Analytics Engine, Workflows bridge, and basic usage accounting work.

## Platform Primitives

- **Workers AI, Vectorize, and AI Gateway**
  - Not exposed to apps yet.
  - Needs stronger usage accounting and limit enforcement before broad access because these features can burn platform quota quickly.
  - Likely shape: W7S-owned service-binding bridge first, then optional direct app bindings later if the accounting and isolation story is clear.

- **Turnstile**
  - No managed site-key/secret flow yet.
  - Could support user-provided config first, then managed provisioning later.

- **Email Routing**
  - No inbound email bridge yet.
  - Likely shape: W7S core receives Cloudflare Email Routing events and dispatches to app-declared backend paths.

## Product APIs

- **Deployment list/history API**
  - Only the latest deployment record is stored per owner/repo/environment.
  - Need append-only deploy history and authenticated list/get endpoints.

- **Rollback/delete API**
  - No public rollback or deletion workflow yet.
  - Needs careful handling for dispatch namespace scripts, static manifests, custom-domain mappings, queue mappings, schedule mappings, and durable resources.

- **User-facing logs**
  - No per-app log retrieval yet.
  - Needs a storage/query design that is cheap and does not leak cross-tenant data.

- **Analytics query API/dashboard**
  - Internal Analytics Engine writes exist.
  - No W7S API or UI exposes those metrics yet.

- **Usage limits API**
  - Basic daily KV usage rollups now exist.
  - Soft warning limits now exist in the usage API.
  - Effective policy reads and W7S-owned KV overrides now exist.
  - A report-only `checkUsageLimit(...)` hook now exists for future expensive primitives.
  - No hard quota, rate-limit, billing-grade accounting, or admin policy write API exists yet.

## Developer Experience

- **Typed client package**
  - `W7S_RPC`, `W7S_QUEUE`, and `W7S_WORKFLOW` currently use low-level `fetch(...)` conventions.
  - A typed helper package should standardize headers, errors, retries, and status parsing.

- **Backend bundling**
  - Native backend deploy supports relative local imports only.
  - Apps that depend on npm packages must bundle before deployment.

- **First-party examples**
  - Examples exist for fullstack, RPC, queues, schedules, Durable Objects, and workflows.
  - Hyperdrive still needs a useful public smoke test with a real Postgres origin.
  - AI, Turnstile, and Email Routing examples do not exist yet.

## Resource Management

- **Managed Hyperdrive**
  - W7S can bind existing Hyperdrive config IDs.
  - It does not create configs or rotate credentials yet.

- **Durable Object lifecycle**
  - W7S creates initial SQLite-backed classes and keeps stable script names.
  - It does not automate class renames, transfers, or deletes.

- **App-visible Analytics Engine**
  - W7S core writes internal platform analytics.
  - Apps cannot declare their own Analytics Engine dataset bindings yet.

## Operations

- **Custom-domain DNS**
  - W7S attaches routes and stores mappings.
  - DNS records remain manual.

- **Wildcard DNS**
  - `*.w7s.cloud` DNS is expected to exist outside this repo's automation.

- **Accounting and limits**
  - Daily KV usage rollups exist for deploy, RPC, queue, schedule, and workflow paths.
  - The usage API evaluates daily soft limits from default policy plus W7S-owned KV overrides and returns warning metadata.
  - `checkUsageLimit(...)` reports projected exceedance with `wouldBlock`, but does not enforce blocking.
  - They are best-effort read-modify-write counters, so concurrent writes can be approximate.
  - Hard limits and billing-grade accounting still need a stronger storage/enforcement path before AI/Vectorize/AI Gateway are exposed broadly.
