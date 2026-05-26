# Observability

W7S has two observability paths:

- platform analytics from W7S core events;
- user Worker console and exception logs captured from Cloudflare Tail Worker events.

## Analytics API

Read per-repository platform analytics with a GitHub token that can access the repo:

```sh
curl "https://w7s.cloud/api/v1/analytics/<owner>/<repo>?hours=24&limit=50" \
  -H "Authorization: Bearer $GITHUB_TOKEN"
```

Query parameters:

```text
environment  W7S environment, defaults to production
hours        trailing lookback window, 1 to 168, defaults to 24
from         optional ISO timestamp, overrides hours start
to           optional ISO timestamp, defaults to now
bucket       hour or day, defaults to hour
limit        recent event limit, 1 to 200, defaults to 50
```

Response shape:

```json
{
  "status": "success",
  "data": {
    "analytics": {
      "configured": true,
      "dataset": "w7s_platform_events",
      "repository": "owner/repo",
      "environment": "production",
      "from": "2026-05-26T00:00:00.000Z",
      "to": "2026-05-26T12:00:00.000Z",
      "bucket": "hour",
      "summary": [
        {
          "event": "runtime_request",
          "outcome": "success",
          "count": 120,
          "samples": 120,
          "avgDurationMs": 8.2
        }
      ],
      "timeseries": [
        {
          "bucket": "2026-05-26 12:00:00",
          "event": "runtime_request",
          "count": 12
        }
      ],
      "events": [
        {
          "timestamp": "2026-05-26 12:05:00",
          "event": "runtime_request",
          "outcome": "success",
          "source": "worker",
          "target": "",
          "method": "GET",
          "count": 1,
          "status": 200,
          "durationMs": 9
        }
      ]
    }
  }
}
```

If `W7S_ANALYTICS_DATASET` is not configured, the endpoint returns `configured: false` with empty arrays.

## Event Schema

Analytics Engine columns are written by [analytics.ts](../src/analytics.ts):

```text
index1   repository
blob1    event
blob2    repository
blob3    environment
blob4    org slug
blob5    repo slug
blob6    outcome
blob7    source
blob8    target
blob9    method
double1  count
double2  status
double3  duration milliseconds
```

Queries account for Analytics Engine sampling with `_sample_interval`.

## Worker Logs API

Every native backend uploaded by W7S gets a `tail_consumers` entry pointing at the W7S core Worker unless `W7S_DISABLE_WORKER_LOGS` is set. The core Worker exposes a `tail()` handler, maps the Tail Worker `scriptName` back to a deployed repository, and stores only mapped user Worker records in `DEPLOYMENTS_KV`.

Read logs with a GitHub token that can access the repo:

```sh
curl "https://w7s.cloud/api/v1/logs/<owner>/<repo>?hours=1&limit=100" \
  -H "Authorization: Bearer $GITHUB_TOKEN"
```

Query parameters:

```text
environment  W7S environment, defaults to production
hours        trailing lookback window, 1 to 168, defaults to 1
from         optional ISO timestamp, overrides hours start
to           optional ISO timestamp, defaults to now
kind         console, exception, or outcome
level        debug, info, log, warn, or error
limit        record limit, 1 to 500, defaults to 100
cursor       opaque cursor from a previous response
```

Response shape:

```json
{
  "status": "success",
  "data": {
    "logs": {
      "repository": "owner/repo",
      "environment": "production",
      "from": "2026-05-26T11:00:00.000Z",
      "to": "2026-05-26T12:00:00.000Z",
      "limit": 100,
      "cursor": null,
      "records": [
        {
          "version": 1,
          "id": "log-id",
          "kind": "console",
          "timestamp": "2026-05-26T12:00:01.000Z",
          "observedAt": "2026-05-26T12:00:02.000Z",
          "repository": "owner/repo",
          "environment": "production",
          "orgSlug": "owner",
          "repoSlug": "repo",
          "scriptName": "owner--repo--production--commit",
          "outcome": "ok",
          "level": "log",
          "message": ["hello"],
          "text": "hello",
          "request": {
            "method": "GET",
            "path": "/api/hello",
            "status": 200,
            "colo": "IAD"
          }
        }
      ]
    }
  }
}
```

Exception records use `kind: "exception"` and include `exception.name`, `exception.message`, and `exception.stack` when Cloudflare provides a stack. Non-OK invocations without a specific exception are stored as `kind: "outcome"`.

Default retention is seven days. Operators can set `W7S_LOG_RETENTION_SECONDS` up to 30 days. Existing user Workers need to be redeployed once after this feature ships so their upload metadata includes the Tail Worker consumer.
