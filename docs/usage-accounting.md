# Usage Accounting

W7S keeps best-effort daily usage rollups for each deployed repository and environment. The first version is intentionally simple: it stores aggregate counters in `DEPLOYMENTS_KV` and exposes them through a GitHub-authenticated API.

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
    }
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

## Limits

KV rollups are read-modify-write counters. Concurrent writes can race, so this is not billing-grade accounting and should not be used for strict quota enforcement yet. It is sufficient for product visibility, support debugging, and planning the next accounting layer before AI, Vectorize, and AI Gateway are exposed broadly.
