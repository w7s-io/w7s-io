# Agent Handoff

## Current State

As of the latest docs update:

- `w7s-io` is deployed from GitHub Actions on push to `main`.
- `W7S_ATTACH_WILDCARD_ROUTE=true` is set in GitHub repo variables.
- The Worker route `*.w7s.cloud/*` is attached by the deploy workflow.
- Wildcard DNS is expected to be managed manually.
- `backend/`, `worker/`, and `frontend/dist` deploys are supported.
- The demo repo `guerrerocarlos/w7s-io-demo` deploys successfully through the reusable deploy action.

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
- Static hosting only supports `frontend/dist`.
- No custom-domain management for deployed repos yet.
- No rollback UI or deployment history API yet.
- No user-facing logs yet.
- Wildcard DNS is manual.

## Common Next Tasks

Good near-term tasks:

- add an API to list/get deployment records;
- expose deploy history per org/repo/environment;
- improve native backend bundling support;
- add delete/rollback for deployed user Workers;
- add a first-party plugin manifest/RPC convention;
- add structured deploy logs;
- add end-to-end tests that deploy a demo archive against a staging Worker.

## Important Repos

```text
Core:         https://github.com/w7s-io/w7s-io
Legacy:       https://github.com/w7s-io/w7s-cloud
Deploy action:https://github.com/w7s-io/w7s-cloud/tree/main/.github/actions/w7s-deploy
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
   curl -fsS https://w7s.cloud/api/v1/health
   ```

6. If working on public org routes, confirm DNS for the test org host resolves before debugging app code.

