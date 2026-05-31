# w7s-local

Local W7S routing simulator for app development, powered directly by `workerd`.

`w7s-local` does not require `wrangler`, a Cloudflare account, KV, R2, or Workers for Platforms. It generates a temporary `workerd` config, runs a local Worker that mirrors the W7S URL shape, serves static build output from disk, and proxies to a local backend/dev server.

## Usage

```sh
npx w7s-local --backend http://localhost:5173
npx w7s-local --frontend dist
npx w7s-local --command "npm run dev -- --host 127.0.0.1 --port 5173" --backend http://localhost:5173
```

Local W7S URL shape:

```text
http://<owner>.local.w7s.cloud:8787/<repo>/
http://<branch>--<owner>.local.w7s.cloud:8787/<repo>/
```

When DNS for `local.w7s.cloud` is not available locally, use the host header:

```sh
curl -H "host: acme.local.w7s.cloud" http://127.0.0.1:8787/app/
```

## Options

```text
--root <dir>             App root. Defaults to cwd.
--owner <slug>           GitHub owner/org slug. Inferred from git remote when possible.
--repo <slug>            GitHub repo slug. Inferred from package.json or cwd.
--environment <name>     W7S environment. Defaults to production.
--base-domain <domain>   Local W7S base domain. Defaults to local.w7s.cloud.
--port <port>            Local workerd HTTP port. Defaults to 8787.
--frontend <dir>         Static output directory. Auto-detected by W7S conventions.
--backend <url>          Backend/dev server origin to proxy after stripping the repo prefix.
--command <command>      Start a dev command before serving.
--workerd <path>         workerd executable. Defaults to the bundled npm dependency.
```

## What It Simulates

- W7S host parsing for owner, branch environments, and owner-root apps.
- Repo prefix stripping before backend proxying.
- `x-w7s-org-slug`, `x-w7s-repo-slug`, and `x-w7s-original-path` headers.
- Static output detection for `frontend/dist`, `dist/client`, `dist`, `build`, and `out`.
- Static exact match before backend proxy.
- SPA fallback after backend `404` or `405`.

It intentionally does not emulate KV, R2, D1, Durable Objects, queues, workflows, Workers AI, or Workers for Platforms. Apps should use local service doubles for those bindings during development.

## Publishing

The package is published by `.github/workflows/publish-w7s-local.yml` on every push to `main`. The workflow uses npm trusted publishing, so it does not need an npm automation token. It queries the latest published version and publishes the next patch version.

Configure npm trusted publishing for:

```text
Package: w7s-local
Provider: GitHub Actions
Organization or user: w7s-io
Repository: w7s-core
Workflow filename: publish-w7s-local.yml
Environment name: leave empty
Allowed actions: npm publish
```

npm requires the package to exist before a trusted publisher can be configured. For the first registry bootstrap, publish `w7s-local@0.1.0` once with an npm account that owns the package, then add the trusted publisher above.
