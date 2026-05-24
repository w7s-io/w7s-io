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
- `src/deploy/archive.ts`
  - Reads zip archives into normalized file maps.
  - Strips common GitHub archive roots while preserving W7S app roots.
- `src/deploy/isolatePublisher.ts`
  - Publishes `backend/` or `worker/` apps into a Workers for Platforms dispatch namespace.
  - Supports local relative JS/TS module graphs only.
- `src/deploy/appManifest.ts`
  - Reads optional `w7s.json` manifests from deploy archives.
  - Validates storage binding declarations and runtime value names.
- `src/deploy/storageProvisioner.ts`
  - Creates or reuses per-app KV namespaces, R2 buckets, and D1 databases.
  - Applies D1 migrations declared by the app manifest.
  - Builds Worker upload metadata bindings for storage, vars, and secrets.
- `src/deploy/rpcBindings.ts`
  - Creates the per-deployment RPC bearer token.
  - Adds `W7S_RPC`, `W7S_RPC_TOKEN`, and caller metadata bindings to native Workers.
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
  -> provision declared app storage for native Workers
  -> publish native Worker to dispatch namespace
  -> detect static frontend output
  -> upload static files to R2
  -> store deployment record in KV
```

```text
GET https://<org>.w7s.cloud/<repo>/<path>
  -> resolve org from host
  -> resolve repo from first path segment, or same-name org root repo
  -> load deployment record from KV
  -> serve exact static asset if present
  -> dispatch to native Worker if present
  -> if native Worker returns 404/405, serve static SPA fallback if present
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
- Backend-to-backend RPC is routed through the core Worker service binding. It does not expose target Workers directly, and cross-owner calls are opt-in through the target app's `w7s.json`.
