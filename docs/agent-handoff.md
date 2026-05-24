# Agent Handoff

## Current State

As of the latest docs update:

- `w7s-io` is deployed from GitHub Actions on push to `main`.
- `W7S_ATTACH_WILDCARD_ROUTE=true` is set in GitHub repo variables.
- The Worker route `*.w7s.cloud/*` is attached by the deploy workflow.
- Wildcard DNS is expected to be managed manually.
- `backend/`, `worker/`, and static frontend deploys are supported.
- Native backends can declare per-app KV, R2, D1, vars, and secrets in `w7s.json`.
- Native backends receive `W7S_RPC`, `W7S_RPC_TOKEN`, and W7S metadata vars for backend-to-backend RPC.
- Same-owner RPC is allowed by default; cross-owner RPC requires the target app to list allowed owners or repos in `w7s.json` under `rpc.allow`.
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
- Static hosting supports `frontend/dist`, `dist/client`, `dist`, `build`, and `out`.
- Custom-domain DNS is manual; W7S only stores the host mapping and attaches a Worker route.
- W7S custom-domain verification is soft. A missing TXT record allows the first claim, so serious custom-domain users should add `_w7s.<zone>` with a GitHub owner or `owner/repo` allowlist.
- RPC currently uses a low-level `env.W7S_RPC.fetch(...)` convention. There is no typed client package yet.
- No rollback UI or deployment history API yet.
- No user-facing logs yet.
- Wildcard DNS is manual.

## Common Next Tasks

Good near-term tasks:

- add an API to list/get deployment records;
- expose deploy history per org/repo/environment;
- improve native backend bundling support;
- add delete/rollback for deployed user Workers;
- add a typed RPC client and first-party plugin conventions on top of `W7S_RPC`;
- add structured deploy logs;
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
