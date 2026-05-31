# W7S Core Docs

This directory is for agents and engineers taking over the greenfield `w7s-io` core.

Start here:

1. [Architecture](./architecture.md): what the core does and what it intentionally does not do.
2. [Deploy API](./deploy-api.md): `POST /api/v1/deploy`, archive expectations, auth, and response shape.
3. [Runtime Routing](./runtime-routing.md): how `https://<org>.w7s.cloud/<repo>/*` and same-name org root apps are resolved.
4. [Cloudflare Operations](./cloudflare-ops.md): bindings, GitHub Actions, wildcard cutover, DNS, and required permissions.
5. [Usage Accounting](./usage-accounting.md): per-app daily usage rollups, warning thresholds, and hard daily limits.
6. [Development And Testing](./development-and-testing.md): local commands, `w7s-local`, tests, and safe change workflow.
7. [Agent Handoff](./agent-handoff.md): current state, known limitations, and common next tasks.

## Current Model

`w7s-io` is the minimal W7S core:

- one Cloudflare Worker hosts the API and landing page;
- GitHub Actions uploads full repo zip archives to `POST /api/v1/deploy`;
- deploy auth is the caller's GitHub token checked against the source repo;
- `backend/` or `worker/` is published as a native Workers for Platforms user Worker;
- optional `w7s.json` manifests declare per-app KV, R2, D1, Durable Objects, Hyperdrive, queues, schedules, workflows, vars, and secrets;
- native backends receive `W7S_RPC`, `W7S_QUEUE`, `W7S_WORKFLOW`, and `W7S_AI` service bindings through the core;
- static frontend output is published to R2 and served as static assets;
- public repo apps are routed as `https://<org>.w7s.cloud/<repo>/*`;
- same-name repos such as `github.com/<org>/<org>` can also serve `https://<org>.w7s.cloud/*`.
- empty org roots such as `https://sadasant.w7s.cloud/` show deploy-help HTML;
- custom domains can be declared with `CNAME` when DNS is managed separately, with optional `_w7s.<zone>` TXT allowlists for ownership control.
- optional Workers Analytics Engine writes provide core platform observability when `W7S_ANALYTICS_DATASET` is configured.
- authenticated analytics reads expose those platform events through `/api/v1/analytics/<owner>/<repo>`.
- authenticated log reads expose user Worker `console.*` output and uncaught exceptions through `/api/v1/logs/<owner>/<repo>`.
- daily repo/owner/global usage rollups, hourly Cloudflare usage sync, app suspension state, short-window burst guards, and effective limit warnings are exposed through `GET /api/v1/usage/<owner>/<repo>`.
- effective limit policies are exposed through `GET /api/v1/limits/<owner>/<repo>`.
- optional Telegram manager notifications can report deploys, deploy warnings/errors, app suspensions, and usage collection failures when `W7S_TELEGRAM_BOT_TOKEN` and `W7S_TELEGRAM_CHAT_ID` are configured.
- repo Telegram subscribers can be linked by the deploy action with `telegram-chat-id`; the bot webhook replies to `/start` with the chat id and setup instructions.

The old workflow editor, `jsInterpreter`, plugin bridge, DB control, and telemetry stack are not part of this core.
