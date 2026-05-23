# Deploy API

## Endpoint

```text
POST https://w7s.cloud/api/v1/deploy
```

The body must be a zip archive of the full repository or a deployable subdirectory.

## Required Headers

```text
Authorization: Bearer <github-token>
x-github-repository: <owner>/<repo>
x-github-sha: <commit-sha>
x-github-branch: <branch-name>
content-type: application/zip
```

`application/octet-stream` is also accepted for zip uploads.

## Authentication

The deploy token is checked against GitHub:

```text
GET https://api.github.com/repos/<owner>/<repo>
Authorization: Bearer <github-token>
```

If GitHub returns `401`, `403`, or `404`, W7S rejects the deploy with `401`.

This means deploy permission is equivalent to GitHub repo read access. The intended caller is GitHub Actions using `${{ github.token }}`.

## Environment Selection

Optional overrides:

- query: `?environment=staging`
- header: `x-w7s-environment: staging`

Default behavior:

- `main` and `master` deploy to `production`;
- all other branches deploy to a sanitized branch name.

## Archive Layout

Native backend roots:

```text
backend/index.js
backend/index.mjs
backend/index.ts
backend/index.mts
worker/index.js
worker/index.mjs
worker/index.ts
worker/index.mts
```

Static frontend root:

```text
frontend/dist/
```

Both native backend and static frontend can be present in the same archive.

## Native Backend Rules

The native backend is published to Cloudflare Workers for Platforms.

Supported imports:

- relative imports inside the same root, such as `./lib.js`;
- TypeScript files are transpiled with Babel before upload.

Unsupported imports:

- bare package imports such as `import x from "pkg"`;
- imports crossing outside `backend/` or `worker/`.

If a repo needs dependencies, it should bundle in CI and upload the bundled backend files.

## Static Frontend Rules

Every file under `frontend/dist` is uploaded to R2.

Static routes:

- exact file paths are served first;
- `/` and directory paths resolve to `index.html` where present;
- if native backend returns `404` or `405`, W7S serves `index.html` as SPA fallback when available.

## Success Response

Example:

```json
{
  "status": "success",
  "data": {
    "deployment": {
      "version": 1,
      "orgSlug": "guerrerocarlos",
      "repoSlug": "w7s-io-demo",
      "environment": "production",
      "repository": "guerrerocarlos/w7s-io-demo",
      "branch": "main",
      "commitSha": "abc123",
      "deployedAt": "2026-05-23T17:15:11.770Z",
      "targets": {
        "worker": {
          "namespace": "w7s-isolate",
          "scriptName": "guerrerocarlos--w7s-io-demo--production",
          "entrypoint": "backend/index.js",
          "compatibilityDate": "2026-05-23",
          "startupTimeMs": 0
        },
        "static": {
          "manifestKey": "static_manifest:v1:production:guerrerocarlos:w7s-io-demo",
          "assetPrefix": "static/v1/production/guerrerocarlos/w7s-io-demo/abc123",
          "fileCount": 3,
          "hasIndex": true
        }
      }
    },
    "url": "https://guerrerocarlos.w7s.cloud/w7s-io-demo/"
  }
}
```

For same-name repos, the public URL is the org root. A deploy from `guerrerocarlos/guerrerocarlos` returns:

```json
{
  "status": "success",
  "data": {
    "url": "https://guerrerocarlos.w7s.cloud/"
  }
}
```

## Common Failures

- `401 Missing bearer token`
  - `Authorization: Bearer ...` is absent.
- `401 Bearer token is not authorized`
  - GitHub token cannot read the repo in `x-github-repository`.
- `400 Archive must contain worker/, backend/, or frontend/dist`
  - Archive does not contain a deployable root.
- `400 Native backend deploy requires ...`
  - `backend/` or `worker/` exists but no supported `index.*` entrypoint exists.
- `500 Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID`
  - Core Worker secrets are missing; deploy cannot publish native Workers.
