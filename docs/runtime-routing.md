# Runtime Routing

## Public URL Shape

```text
https://<org>.w7s.cloud/<repo>/<path>
```

Examples:

```text
https://guerrerocarlos.w7s.cloud/w7s-io-demo/
https://guerrerocarlos.w7s.cloud/w7s-io-demo/api/hello
```

## Host Resolution

`src/runtime/host.ts` resolves org hosts for the configured base domain.

Default base domain:

```text
w7s.cloud
```

Supported host forms:

- `<org>.w7s.cloud`
  - environment candidates: `production`
- `dev-<org>.w7s.cloud`
  - environment candidates: `dev`, then `production`
- `staging-<org>.w7s.cloud`
  - environment candidates: `staging`, then `production`
- `preview-<org>.w7s.cloud`
  - environment candidates: `preview`, then `production`

Reserved labels such as `www`, `api`, and `app` are not treated as org hosts.

## Path Resolution

The first path segment is the repo slug.

```text
/w7s-io-demo/api/hello
```

resolves to:

- repo slug: `w7s-io-demo`
- repo path passed to the native Worker: `/api/hello`

Reserved platform paths:

- `/api/v1/*`

Reserved paths are handled by the core Worker and are not routed to deployed apps.

## Deployment Lookup

`src/runtime/router.ts` loads a deployment record from KV using:

```text
deployment:v1:<environment>:<orgSlug>:<repoSlug>
```

If the host has multiple environment candidates, W7S tries them in order.

## Routing Priority

For repo requests:

1. Exact static asset from `frontend/dist`.
2. Native Worker dispatch through `env.DISPATCHER`.
3. Static SPA fallback (`index.html`) when native Worker returns `404` or `405`.
4. `404`.

This priority lets a repo ship static frontend files and a backend API in the same deploy.

## Dispatch Behavior

When dispatching to the native Worker:

- repo prefix is stripped;
- original path is preserved in `x-w7s-original-path`;
- org slug is sent as `x-w7s-org-slug`;
- repo slug is sent as `x-w7s-repo-slug`.

Example:

```text
Incoming:
  https://guerrerocarlos.w7s.cloud/w7s-io-demo/api/hello

Dispatched to user Worker as:
  /api/hello
```

## Static Behavior

Static assets are loaded from an R2 manifest stored in KV.

Exact match candidates:

- `<path>`
- `<path>/index.html`
- `index.html` for repo root

SPA fallback:

- only applies to `GET` and `HEAD`;
- only applies when `index.html` exists;
- only used after native Worker misses with `404` or `405`.

