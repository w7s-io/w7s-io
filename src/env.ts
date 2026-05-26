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
  W7S_WORKER_NAME?: string;
  W7S_BASE_DOMAIN?: string;
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
