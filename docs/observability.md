# Observability

W7S writes platform events to Workers Analytics Engine when `W7S_ANALYTICS_DATASET` is configured. These events are core platform events, not user Worker `console.log` output.

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

## Remaining Logs Gap

The analytics API is enough for platform event logs and dashboard data. It does not capture user Worker `console.log`, stack traces, or arbitrary application logs yet. That needs a separate design, likely backed by a tail/logpush pipeline or a W7S-owned structured logging binding, with strict per-repo filtering.
