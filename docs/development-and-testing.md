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
npm run deploy
```

`npm run check` runs TypeScript and all Vitest tests.

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
   gh run list --repo w7s-io/w7s-io --limit 3
   gh run watch <run-id> --repo w7s-io/w7s-io --exit-status
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
- `frontend/dist`;
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
