export type DispatchNamespace = {
  get: (
    name: string,
    props?: Record<string, unknown>,
    options?: {
      limits?: {
        cpuMs?: number;
        subRequests?: number;
      };
    }
  ) => {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };
};

export interface Env {
  DISPATCHER?: DispatchNamespace;
  DEPLOYMENTS_KV: KVNamespace;
  STATIC_ASSETS?: R2Bucket;
  W7S_ANALYTICS?: AnalyticsEngineDataset;
  W7S_WORKFLOWS?: Workflow<W7SWorkflowPayload>;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_DISPATCH_NAMESPACE?: string;
  CLOUDFLARE_ISOLATE_COMPATIBILITY_DATE?: string;
  W7S_USER_WORKER_CPU_MS?: string;
  W7S_USER_WORKER_SUBREQUESTS?: string;
  W7S_ANALYTICS_DATASET?: string;
  W7S_LOG_RETENTION_SECONDS?: string;
  W7S_LOG_TAIL_CONSUMER?: string;
  W7S_DISABLE_WORKER_LOGS?: string;
  W7S_QUEUE_MAX_MESSAGE_BYTES?: string;
  W7S_QUEUE_BATCH_SIZE?: string;
  W7S_QUEUE_MAX_RETRIES?: string;
  W7S_QUEUE_RETRY_DELAY_SECONDS?: string;
  W7S_QUEUE_VISIBILITY_TIMEOUT_MS?: string;
  W7S_WORKFLOW_MAX_PAYLOAD_BYTES?: string;
  W7S_WORKFLOW_ACTIVE_LIMIT?: string;
  W7S_WORKFLOW_ACTIVE_TTL_SECONDS?: string;
  W7S_WORKFLOW_MAX_RETRIES?: string;
  W7S_WORKFLOW_RETRY_DELAY_SECONDS?: string;
  W7S_WORKFLOW_TIMEOUT_SECONDS?: string;
  W7S_STATIC_RETENTION_DAYS?: string;
  W7S_USAGE_RETENTION_DAYS?: string;
  W7S_WORKER_SCRIPT_RETENTION_DAYS?: string;
  W7S_WORKER_NAME?: string;
  W7S_RUNTIME_CACHE_SCOPE?: string;
  W7S_BASE_DOMAIN?: string;
  W7S_STATUS_COMPONENTS_JSON?: string;
  W7S_STATUS_REGIONS_JSON?: string;
  W7S_STATUS_INCIDENTS_JSON?: string;
  W7S_TELEGRAM_BOT_TOKEN?: string;
  W7S_TELEGRAM_CHAT_ID?: string;
  W7S_TELEGRAM_EVENTS?: string;
  APP_COMMIT_ID?: string;
  APP_DEPLOY_BRANCH?: string;
  APP_DEPLOYED_AT?: string;
}

export type W7SWorkflowPayload = {
  version: 1;
  createdAt: string;
  payload: unknown;
  caller: {
    orgSlug: string;
    repoSlug: string;
    repository: string;
    environment: string;
  };
  target: {
    orgSlug: string;
    repoSlug: string;
    repository: string;
    environment: string;
    workflow: string;
    path: string;
  };
};
