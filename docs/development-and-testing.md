# Development And Testing

## Local Setup

```sh
npm install
```

Main commands:

```sh
npm run typecheck
npm run test
npm run check
npm run dev
npm run local:dev
npm run deploy
```

`npm run check` runs TypeScript and all Vitest tests.

## Local W7S Environment

Use `w7s-local` when an app developer needs the W7S routing model locally without running Wrangler or provisioning Cloudflare resources.

```sh
npx w7s-local --backend http://localhost:5173
```

or, from this repository checkout:

```sh
npm run local:dev -- --backend http://localhost:5173
```

The package lives in:

```text
packages/w7s-local
```

It starts `workerd` directly from the npm package dependency. A generated local Worker mirrors W7S URL routing, serves static output through a disk service binding, proxies to a local backend/dev server, strips the repo prefix before backend requests, and sets W7S headers:

```text
x-w7s-org-slug
x-w7s-repo-slug
x-w7s-original-path
```

Local W7S URL shape:

```text
http://<org>.local.w7s.cloud:8787/<repo>/
http://<branch>--<org>.local.w7s.cloud:8787/<repo>/
```

If local DNS for `local.w7s.cloud` is not available, pass the host header directly:

```sh
curl -H "host: guerrerocarlos.local.w7s.cloud" http://127.0.0.1:8787/w7s-io-demo/
```

Useful options:

```sh
w7s-local --owner acme --repo app --frontend dist
w7s-local --owner acme --repo app --environment feature-login --backend http://localhost:3000
w7s-local --command "npm run dev -- --host 127.0.0.1 --port 5173" --backend http://localhost:5173
w7s-local --workerd ./node_modules/.bin/workerd --frontend dist
```

`w7s-local` intentionally does not emulate KV, R2, D1, Durable Objects, queues, workflows, Workers AI, or Workers for Platforms. Apps should use local service doubles for those bindings during development.

### Publishing w7s-local

`.github/workflows/publish-w7s-local.yml` publishes `w7s-local` automatically on every push to `main` using npm trusted publishing. The workflow runs the full repo check, verifies the npm package exists, calculates the next patch version from the latest npm registry version, updates the package version in the workflow workspace, dry-runs the package contents, and publishes with OIDC.

npm trusted publisher settings:

```text
Package: w7s-local
Provider: GitHub Actions
Organization or user: w7s-io
Repository: w7s-core
Workflow filename: publish-w7s-local.yml
Environment name: leave empty
Allowed actions: npm publish
```

npm requires the package to exist before a trusted publisher can be configured. Bootstrap the package once with a maintainer npm account, then enable the trusted publisher above for subsequent automatic publishes.

## Test Coverage

Tests live in `src/__tests__`.

Current test areas:

- archive normalization;
- deploy API success/failure paths;
- native backend publishing helpers;
- runtime static and native dispatch routing.

Test helpers:

- `src/__tests__/mocks.ts`
  - in-memory KV;
  - in-memory R2;
  - mock `Env`.

## Wrangler Dry Run

For local packaging validation:

```sh
npx wrangler deploy --dry-run
```

The checked-in `wrangler.jsonc` contains current production bindings for local Wrangler commands. GitHub Actions still uses `wrangler.generated.jsonc`, generated from live Cloudflare resource state during deploy.

## Safe Change Workflow

1. Keep changes scoped to the minimal core.
2. Run:

   ```sh
   npm run check
   ```

3. If changing Cloudflare deploy config, also run:

   ```sh
   node --check scripts/prepare-cloudflare-config.mjs
   ```

4. Commit and push.
5. Watch the GitHub Actions deploy run:

   ```sh
   gh run list --repo w7s-io/w7s-core --limit 3
   gh run watch <run-id> --repo w7s-io/w7s-core --exit-status
   ```

6. Verify health:

   ```sh
   curl -fsS https://w7s.cloud/health
   curl -fsS https://w7s.cloud/api/v1/health
   ```

   The response includes `commitId`, `branch`, and `deployedAt` for GitHub Actions deploys.

## Demo Repo

Current simple demo:

```text
https://github.com/guerrerocarlos/w7s-io-demo
```

It contains:

- `backend/index.js`;
- built static frontend output;
- GitHub workflow using `w7s-io/w7s-cloud/.github/actions/w7s-deploy@main`.

The deploy action lives in:

```text
https://github.com/w7s-io/w7s-cloud/tree/main/.github/actions/w7s-deploy
```

## Debugging Public Routing

If a repo deployed successfully but the public URL fails:

1. Confirm W7S deploy response has `status: success`.
2. Confirm `*.w7s.cloud/*` route is attached to `w7s-io`.
3. Confirm wildcard DNS resolves:

   ```sh
   getent hosts <org>.w7s.cloud
   ```

4. Test the core health endpoint:

   ```sh
   curl -fsS https://w7s.cloud/health
   curl -fsS https://w7s.cloud/api/v1/health
   ```

If DNS is missing, routing code will not run.
