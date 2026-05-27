# Usage Accounting

W7S keeps daily usage rollups for each deployed repository and environment. W7S-managed paths update counters directly, and direct Cloudflare resources are synced hourly from Cloudflare analytics into the same daily rollup.

The same response includes daily limits and warnings. W7S enforces immediate limits on deploys, runtime requests, RPC dispatches, queue sends, workflow starts, log ingestion, and internal queue/schedule/workflow deliveries. Direct binding usage such as D1/R2/KV/Durable Object cost is enforced after the hourly Cloudflare sync.

Every repo usage event is also aggregated into owner-level and global daily rollups. Runtime guards check all three scopes, so one owner cannot multiply the free tier across many repos, and the whole shared account has a final circuit breaker.

## API

Read one repo's usage for one day:

```sh
curl "https://w7s.cloud/api/v1/usage/<owner>/<repo>?date=2026-05-26" \
  -H "Authorization: Bearer $GITHUB_TOKEN"
```

Include hourly Cloudflare records:

```sh
curl "https://w7s.cloud/api/v1/usage/<owner>/<repo>?date=2026-05-26&include=hourly" \
  -H "Authorization: Bearer $GITHUB_TOKEN"
```

The bearer token must be able to access `github.com/<owner>/<repo>`. This is the same authorization model used by deploys.

Optional environment override:

```text
?environment=staging
x-w7s-environment: staging
```

Without an override, usage reads default to `production`.

Read the effective limit policy without usage counters:

```sh
curl "https://w7s.cloud/api/v1/limits/<owner>/<repo>" \
  -H "Authorization: Bearer $GITHUB_TOKEN"
```

The bearer token must be able to access the same GitHub repository.

## Storage

Rollups are stored in `DEPLOYMENTS_KV` under:

```text
usage_daily:v1:<date>:<environment>:<owner>:<repo>
usage_owner_daily:v1:<date>:<environment>:<owner>
usage_global_daily:v1:<date>:<environment>
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
      "cloudflareSyncedAt": "2026-05-26T13:03:00.000Z",
      "cloudflareHours": ["2026-05-26T12"],
      "updatedAt": "2026-05-26T12:00:00.000Z"
    },
    "limits": {
      "version": 1,
      "period": "daily",
      "mode": "enforce",
      "metrics": {
        "workflow.create": {
          "metric": "workflow.create",
          "used": 4,
          "limit": 1000,
          "remaining": 996,
          "usageRatio": 0.004,
          "status": "ok",
          "source": "default"
        }
      },
      "warnings": []
    },
    "policy": {
      "version": 1,
      "period": "daily",
      "mode": "enforce",
      "environment": "production",
      "orgSlug": "w7s-io",
      "repoSlug": "example-workflows",
      "policy": {
        "workflow.create": {
          "metric": "workflow.create",
          "dailyUnits": 1000,
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
runtime.request
worker.request
runtime.cpu_ms
worker.script
static.r2_class_a
static.r2_class_b
r2.class_a
r2.class_b
r2.storage_bytes
kv.read
kv.write
kv.delete
kv.list
kv.storage_bytes
d1.rows_read
d1.rows_written
d1.read_queries
d1.write_queries
d1.storage_bytes
durable_object.request
durable_object.duration_ms
durable_object.rows_read
durable_object.rows_written
durable_object.storage_read_units
durable_object.storage_write_units
durable_object.storage_deletes
rpc.dispatch
queue.send
queue.delivery
schedule.delivery
workflow.create
workflow.delivery
log.write
```

`count` is the event count. `units` is usually the same value, except batch-like paths can record more than one unit per event, such as queue deliveries, bytes, rows, or CPU milliseconds. Cloudflare-polled metrics can have `source: "cloudflare"` or `source: "cloudflare_estimated"` when Cloudflare exposes only a derived signal.

## Daily Limits

Current default daily limits:

```text
deploy               50
runtime.request      10000
worker.request       10000
runtime.cpu_ms       300000
worker.script        5
static.r2_class_a    1000
static.r2_class_b    20000
r2.class_a           1000
r2.class_b           20000
r2.storage_bytes     104857600
kv.read              10000
kv.write             1000
kv.delete            1000
kv.list              1000
kv.storage_bytes     52428800
d1.rows_read         100000
d1.rows_written      10000
d1.read_queries      10000
d1.write_queries     1000
d1.storage_bytes     52428800
durable_object.request       5000
durable_object.duration_ms   300000
durable_object.rows_read     100000
durable_object.rows_written  10000
durable_object.storage_read_units  100000
durable_object.storage_write_units 10000
durable_object.storage_deletes     10000
rpc.dispatch         10000
queue.send           10000
queue.delivery       10000
schedule.delivery    2000
workflow.create      1000
workflow.delivery    1000
log.write            5000
```

Owner-level default limits are 10x the repo defaults, with minimums of 200 deploys/day and 50 Worker scripts/day. Global default limits are 100x the repo defaults, with minimums of 2,000 deploys/day and 1,000 Worker scripts/day.

Each metric is marked:

```text
ok        below 80%
warning   at or above 80%
exceeded  above 100%
```

The response duplicates non-`ok` entries in `warnings` so dashboards and CLIs can show a simple alert list without scanning every metric. Requests that would push a metric above its effective daily limit return HTTP `429`.

## Enforcement

W7S also has a reusable `checkUsageLimit(...)` helper for expensive primitives. It reads the effective policy, reads the current daily usage rollup, and projects whether a requested number of units would exceed the daily limit.

The hook reports hard enforcement and includes the scope that blocked the request:

```json
{
  "mode": "enforce",
  "enforcement": "hard",
  "metric": "workflow.create",
  "scope": "repo",
  "used": 8,
  "requestedUnits": 3,
  "projectedUnits": 11,
  "limit": 10,
  "status": "warning",
  "projectedStatus": "exceeded",
  "wouldBlock": true
}
```

`wouldBlock: true` means the request exceeds policy. Public APIs return HTTP `429`; internal delivery paths skip dispatch once the effective daily delivery limit would be exceeded.

W7S also has short-window burst guards stored under `usage_rate:v1:*`. These are approximate KV counters with small TTLs. They protect against cost spikes that happen faster than daily limits or hourly Cloudflare analytics can react.

Current burst limits:

```text
deploy            repo 10/10min    owner 50/10min     global 500/10min
runtime.request   repo 300/min     owner 2000/min     global 10000/min
rpc.dispatch      repo 120/min     owner 600/min      global 5000/min
queue.send        repo 120/min     owner 600/min      global 5000/min
queue.delivery    repo 300/min     owner 1500/min     global 10000/min
schedule.delivery repo 120/min     owner 600/min      global 5000/min
workflow.create   repo 60/min      owner 300/min      global 2000/min
workflow.delivery repo 120/min     owner 600/min      global 5000/min
log.write         repo 500/min     owner 2000/min     global 10000/min
```

Burst checks first read all matching counters. If any scope would block the request, W7S returns the rate-limit result without incrementing any burst counter for the rejected attempt. If the daily cap already blocks the request, W7S does not touch burst counters either.

Runtime request burst caps are enforced through app suspension because runtime accounting happens after the response. Daily cap suspensions last until the next UTC day. Burst cap suspensions use the rate-limit `retryAfterSeconds` window, so they clear when the short window resets.

Internal review checklist for burst windows:

- `deploy`: should allow normal rebuild and retry loops without waiting an hour; daily deploy caps handle sustained usage.
- `runtime.request`: should stay low enough to stop traffic spikes before hourly Cloudflare analytics sync catches up.
- `schedule.delivery`: should allow a repo with many cron entries to fire in the same minute.
- `queue.delivery` and `workflow.delivery`: should be reviewed against real fan-out examples before raising.
- `log.write`: should remain conservative; W7S drops whole tail batches when the app is over daily or burst limits and writes a core Worker warning with the dropped count.

## Hourly Cloudflare Sync

The core cron runs once per minute for app schedules and also takes an hourly lock named `usage_collect_lock:v1:<hour>`. The collector queries Cloudflare analytics for the previous closed hour, stores records under:

```text
usage_cf_hourly:v1:<hour>:<environment>:<owner>:<repo>
```

Then it merges those hourly records into the daily rollup. If any reliably attributed metric exceeds its effective daily limit, W7S stores:

```text
app_limit_state:v1:<environment>:<owner>:<repo>
```

Suspended apps return HTTP `429` before static serving, Worker dispatch, deploys, RPC, queue sends, or workflow starts. Apps automatically resume at the next UTC day unless an operator writes a stricter state.

Direct binding limits are delayed by the hourly sync. Immediate protection comes from deploy shape caps, runtime request limits, short-window burst limits, and Cloudflare dispatch custom CPU limits on user Workers. Static asset storage is capped by deploy shape limits, and immutable static assets are served through the Worker Cache API using versioned asset keys to reduce R2 reads. Durable Object storage operation units are attributed by namespace ID when W7S can discover namespace IDs from invocation analytics; stored bytes are not per-app attributable in the current Cloudflare analytics schema and remain a tracked gap.

## Other Cost Guards

Queue sends reject JSON envelopes larger than `W7S_QUEUE_MAX_MESSAGE_BYTES`, default `65536`. New Cloudflare Queue consumers are created with bounded settings:

```text
W7S_QUEUE_BATCH_SIZE               10
W7S_QUEUE_MAX_RETRIES              3
W7S_QUEUE_RETRY_DELAY_SECONDS      10
W7S_QUEUE_VISIBILITY_TIMEOUT_MS    300000
```

Workflow starts reject instance payloads larger than `W7S_WORKFLOW_MAX_PAYLOAD_BYTES`, default `65536`. W7S also tracks active workflow instances in KV and blocks new starts for a target repo when `W7S_WORKFLOW_ACTIVE_LIMIT` is reached, default `50`. Active markers expire after `W7S_WORKFLOW_ACTIVE_TTL_SECONDS`, default `86400`, and are cleared when the W7S workflow delivery finishes. Workflow delivery retry/timeout defaults are:

```text
W7S_WORKFLOW_MAX_RETRIES           3
W7S_WORKFLOW_RETRY_DELAY_SECONDS   10
W7S_WORKFLOW_TIMEOUT_SECONDS       300
```

Worker log ingestion is capped by `log.write`, has a 7-day default retention window, truncates large log values, and drops whole tail batches when the target repo would exceed daily or burst log limits.

## Cleanup

The scheduled handler runs cleanup behind an hourly lock:

```text
cleanup_lock:v1:<hour>
```

Cleanup removes:

- stale static manifests and their R2 objects after `W7S_STATIC_RETENTION_DAYS`, default `7`;
- expired app suspension states after their `resumeAfter`;
- old usage daily, owner, global, and hourly records after `W7S_USAGE_RETENTION_DAYS`, default `14`;
- stale dispatch-namespace Worker scripts and `worker_script:v1:*` mappings after `W7S_WORKER_SCRIPT_RETENTION_DAYS`, default `7`, when they are no longer referenced by the latest deployment.

## Policy Overrides

Limit policies are platform-owned. Apps cannot raise or lower their own limits through `w7s.json`.

W7S reads optional policy override records from `DEPLOYMENTS_KV` in this order:

```text
usage_limit_policy:v1:owner:<owner>
usage_limit_policy:v1:owner_environment:<environment>:<owner>
usage_limit_policy:v1:repo:<owner>:<repo>
usage_limit_policy:v1:repo_environment:<environment>:<owner>:<repo>
usage_limit_policy:v1:owner_total:<owner>
usage_limit_policy:v1:owner_total_environment:<environment>:<owner>
usage_limit_policy:v1:global
usage_limit_policy:v1:global_environment:<environment>
```

The first four scopes tune a repo's own daily policy. `owner_total`, `owner_total_environment`, `global`, and `global_environment` tune aggregate guardrails. Later records override earlier records within their own policy family.

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

Set an owner aggregate circuit breaker:

```sh
npm run limits:set -- \
  --scope owner_total \
  --owner w7s-io \
  --metric durable_object.duration_ms \
  --daily-units 2000000
```

Set a global aggregate circuit breaker:

```sh
npm run limits:set -- \
  --scope global \
  --metric runtime.request \
  --daily-units 2000000
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

KV rollups are read-modify-write counters. Concurrent writes can race, and Cloudflare analytics can arrive late, so this is conservative free-tier protection rather than billing-grade accounting. Metrics marked `cloudflare_estimated` are visible for warnings but are not used to suspend apps.
