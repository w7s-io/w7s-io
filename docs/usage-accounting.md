# Usage Accounting

W7S keeps best-effort daily usage rollups for each deployed repository and environment. The first version is intentionally simple: it stores aggregate counters in `DEPLOYMENTS_KV` and exposes them through a GitHub-authenticated API.

The same response includes daily soft limits and warnings. These limits are visible policy scaffolding only; W7S does not block traffic with them yet.

## API

Read one repo's usage for one day:

```sh
curl "https://w7s.cloud/api/v1/usage/<owner>/<repo>?date=2026-05-26" \
  -H "Authorization: Bearer $GITHUB_TOKEN"
```

The bearer token must be able to access `github.com/<owner>/<repo>`. This is the same authorization model used by deploys.

Optional environment override:

```text
?environment=staging
x-w7s-environment: staging
```

Without an override, usage reads default to `production`.

Read the effective soft limit policy without usage counters:

```sh
curl "https://w7s.cloud/api/v1/limits/<owner>/<repo>" \
  -H "Authorization: Bearer $GITHUB_TOKEN"
```

The bearer token must be able to access the same GitHub repository.

## Storage

Rollups are stored in `DEPLOYMENTS_KV` under:

```text
usage_daily:v1:<date>:<environment>:<owner>:<repo>
```

Example response:

```json
{
  "status": "success",
  "data": {
    "usage": {
      "version": 1,
      "date": "2026-05-26",
      "orgSlug": "w7s-io",
      "repoSlug": "example-workflows",
      "environment": "production",
      "repository": "w7s-io/example-workflows",
      "metrics": {
        "workflow.create": {
          "count": 4,
          "units": 4,
          "success": 4,
          "error": 0,
          "lastAt": "2026-05-26T12:00:00.000Z"
        }
      },
      "updatedAt": "2026-05-26T12:00:00.000Z"
    },
    "limits": {
      "version": 1,
      "period": "daily",
      "mode": "warn",
      "metrics": {
        "workflow.create": {
          "metric": "workflow.create",
          "used": 4,
          "limit": 10000,
          "remaining": 9996,
          "usageRatio": 0.0004,
          "status": "ok",
          "source": "default"
        }
      },
      "warnings": []
    },
    "policy": {
      "version": 1,
      "period": "daily",
      "mode": "warn",
      "environment": "production",
      "orgSlug": "w7s-io",
      "repoSlug": "example-workflows",
      "policy": {
        "workflow.create": {
          "metric": "workflow.create",
          "dailyUnits": 10000,
          "warningThreshold": 0.8,
          "source": "default"
        }
      },
      "lookups": []
    },
    "warnings": []
  }
}
```

## Metrics

Current metric names:

```text
deploy
rpc.dispatch
queue.send
queue.delivery
schedule.delivery
workflow.create
workflow.delivery
```

`count` is the event count. `units` is usually the same value, except batch-like paths can record more than one unit per event, such as queue deliveries.

## Soft Limits

Current daily soft limits:

```text
deploy               100
rpc.dispatch         100000
queue.send           100000
queue.delivery       100000
schedule.delivery    10000
workflow.create      10000
workflow.delivery    10000
```

Each metric is marked:

```text
ok        below 80%
warning   at or above 80%
exceeded  above 100%
```

The response duplicates non-`ok` entries in `warnings` so dashboards and CLIs can show a simple alert list without scanning every metric.

## Enforcement Hook

W7S also has a reusable `checkUsageLimit(...)` helper for future expensive primitives. It reads the effective policy, reads the current daily usage rollup, and projects whether a requested number of units would exceed the daily limit.

The hook is intentionally report-only right now:

```json
{
  "mode": "report",
  "enforcement": "off",
  "metric": "workflow.create",
  "used": 8,
  "requestedUnits": 3,
  "projectedUnits": 11,
  "limit": 10,
  "status": "warning",
  "projectedStatus": "exceeded",
  "wouldBlock": true
}
```

`wouldBlock: true` means the request would exceed policy if hard enforcement were enabled. No current request path blocks on this value yet.

## Policy Overrides

Limit policies are platform-owned. Apps cannot raise or lower their own limits through `w7s.json`.

W7S reads optional policy override records from `DEPLOYMENTS_KV` in this order:

```text
usage_limit_policy:v1:owner:<owner>
usage_limit_policy:v1:owner_environment:<environment>:<owner>
usage_limit_policy:v1:repo:<owner>:<repo>
usage_limit_policy:v1:repo_environment:<environment>:<owner>:<repo>
```

Later records override earlier records. Repo/environment overrides are the most specific.

Policy record shape:

```json
{
  "version": 1,
  "metrics": {
    "workflow.create": {
      "dailyUnits": 5000,
      "warningThreshold": 0.7
    },
    "queue.send": 25000
  },
  "updatedAt": "2026-05-26T00:00:00.000Z"
}
```

A number is shorthand for `dailyUnits`. `warningThreshold` must be greater than `0` and less than or equal to `1`. Unknown metrics are ignored.

## Operator Script

W7S operators should use the repo script instead of hand-editing KV JSON:

```sh
npm run limits:get -- --owner w7s-io --repo example-workflows
```

Set or update a scoped policy:

```sh
npm run limits:set -- \
  --scope repo \
  --owner w7s-io \
  --repo example-workflows \
  --metric workflow.create \
  --daily-units 5000 \
  --warning-threshold 0.7
```

Read a raw scope record:

```sh
npm run limits:get -- --scope repo --owner w7s-io --repo example-workflows
```

Delete one metric from a scope record:

```sh
npm run limits:delete -- \
  --scope repo \
  --owner w7s-io \
  --repo example-workflows \
  --metric workflow.create
```

Delete the whole scope record:

```sh
npm run limits:delete -- --scope repo --owner w7s-io --repo example-workflows
```

The script uses `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` or `ACCOUNT_ID`. If those are not set, it can read the generated `.wrangler/secrets.json` file created by `npm run prepare:cloudflare`.

## Limits Caveat

KV rollups are read-modify-write counters. Concurrent writes can race, so this is not billing-grade accounting and should not be used for strict quota enforcement yet. It is sufficient for product visibility, support debugging, and planning the next accounting layer before AI, Vectorize, and AI Gateway are exposed broadly.
