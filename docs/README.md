# W7S Core Docs

This directory is for agents and engineers taking over the greenfield `w7s-io` core.

Start here:

1. [Architecture](./architecture.md): what the core does and what it intentionally does not do.
2. [Deploy API](./deploy-api.md): `POST /api/v1/deploy`, archive expectations, auth, and response shape.
3. [Runtime Routing](./runtime-routing.md): how `https://<org>.w7s.cloud/<repo>/*` and same-name org root apps are resolved.
4. [Cloudflare Operations](./cloudflare-ops.md): bindings, GitHub Actions, wildcard cutover, DNS, and required permissions.
5. [Development And Testing](./development-and-testing.md): local commands, tests, and safe change workflow.
6. [Agent Handoff](./agent-handoff.md): current state, known limitations, and common next tasks.

## Current Model

`w7s-io` is the minimal W7S core:

- one Cloudflare Worker hosts the API and landing page;
- GitHub Actions uploads full repo zip archives to `POST /api/v1/deploy`;
- deploy auth is the caller's GitHub token checked against the source repo;
- `backend/` or `worker/` is published as a native Workers for Platforms user Worker;
- optional `w7s.json` manifests declare per-app KV, R2, D1, queues, schedules, vars, and secrets;
- native backends receive `W7S_RPC` and `W7S_QUEUE` service bindings through the core;
- static frontend output is published to R2 and served as static assets;
- public repo apps are routed as `https://<org>.w7s.cloud/<repo>/*`;
- same-name repos such as `github.com/<org>/<org>` can also serve `https://<org>.w7s.cloud/*`.
- empty org roots such as `https://sadasant.w7s.cloud/` show deploy-help HTML;
- custom domains can be declared with `CNAME` when DNS is managed separately, with optional `_w7s.<zone>` TXT allowlists for ownership control.

The old workflow editor, `jsInterpreter`, plugin bridge, DB control, and telemetry stack are not part of this core.
