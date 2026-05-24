# Runtime Routing

## Public URL Shape

```text
https://<org>.w7s.cloud/<repo>/<path>
```

Non-production branch deployments use a branch-prefixed host:

```text
https://<branch-name>--<org>.w7s.cloud/<repo>/<path>
```

If a GitHub repo has the same name as the org/user, W7S also mounts that repo at the org root:

```text
https://<org>.w7s.cloud/<path>
```

Examples:

```text
https://guerrerocarlos.w7s.cloud/
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
- `<branch>--<org>.w7s.cloud`
  - environment candidates: `<branch>`, then `production`
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

Org-root routing is reserved for the same-name repo. For example, a deployment from:

```text
github.com/guerrerocarlos/guerrerocarlos
```

can serve:

```text
https://guerrerocarlos.w7s.cloud/
https://guerrerocarlos.w7s.cloud/api/status
https://guerrerocarlos.w7s.cloud/assets/app.js
```

Repo-prefixed deployments keep priority. If `guerrerocarlos/w7s-io-demo` exists, then `/w7s-io-demo/*` routes to that repo before W7S tries the org-root app.

If an org host has no deployment for the requested root or repo-prefixed path, W7S returns the deploy showcase page instead of a plain 404. The page includes the exact GitHub repo that should be used for the URL. For example:

```text
https://sadasant.w7s.cloud/
```

points at:

```text
https://github.com/sadasant/sadasant
```

and:

```text
https://sadasant.w7s.cloud/example/
```

points at:

```text
https://github.com/sadasant/example
```

Custom domains are resolved from KV mappings created during deploy from `CNAME` or supported legacy/static-output CNAME paths. A custom hostname routes directly to its mapped deployment without a repo prefix:

```text
https://whereis.carlosguerrero.com/
https://whereis.carlosguerrero.com/api/profile
https://whereis.carlosguerrero.com/assets/app.js
```

Deploy-time custom-domain claims are soft-verified. The first repo can claim a hostname without TXT, but W7S warns the caller to add `_w7s.<zone>`. If that TXT exists, it must list the GitHub owner or exact repo, for example `guerrerocarlos` or `guerrerocarlos/whereis`. If two repos point at the same hostname, TXT authorization decides whether ownership can move.

Reserved platform paths:

- `/api/v1/*`

Reserved paths are handled by the core Worker and are not routed to deployed apps.

The internal RPC endpoint also lives under the reserved API namespace:

```text
/api/v1/rpc/<owner>/<repo>/<path>
```

Apps should not call that URL over the public internet. Native backends call it through their `W7S_RPC` service binding with the deployment's `W7S_RPC_TOKEN`.

## Deployment Lookup

`src/runtime/router.ts` loads a deployment record from KV using:

```text
deployment:v1:<environment>:<orgSlug>:<repoSlug>
```

Custom domains first load:

```text
custom_domain:v1:<hostname>
```

and then load the mapped deployment record.

If the host has multiple environment candidates, W7S tries them in order.

## Routing Priority

For repo requests:

1. Exact static asset from the detected static frontend root.
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

When dispatching through RPC, the target Worker also receives:

- `x-w7s-rpc: 1`;
- `x-w7s-rpc-caller-owner`;
- `x-w7s-rpc-caller-repo`;
- `x-w7s-rpc-caller-repository`;
- `x-w7s-rpc-caller-environment`.

Example:

```text
Incoming:
  https://guerrerocarlos.w7s.cloud/w7s-io-demo/api/hello

Dispatched to user Worker as:
  /api/hello
```

## Static Behavior

Static assets are loaded from an R2 manifest stored in KV.

For static deployments, the repo root without a trailing slash redirects to the directory URL:

```text
/<repo> -> /<repo>/
```

This keeps relative frontend asset URLs such as `./app.js` scoped under the repo prefix.

Exact match candidates:

- `<path>`
- `<path>/index.html`
- `index.html` for repo root

SPA fallback:

- only applies to `GET` and `HEAD`;
- only applies when `index.html` exists;
- only used after native Worker misses with `404` or `405`.
