export type DispatchNamespace = {
  get: (name: string) => {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  };
};

export interface Env {
  DISPATCHER?: DispatchNamespace;
  DEPLOYMENTS_KV: KVNamespace;
  STATIC_ASSETS?: R2Bucket;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_DISPATCH_NAMESPACE?: string;
  CLOUDFLARE_ISOLATE_COMPATIBILITY_DATE?: string;
  W7S_BASE_DOMAIN?: string;
  APP_COMMIT_ID?: string;
}

