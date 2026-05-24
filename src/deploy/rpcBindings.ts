import type { Env } from "../env";
import type { WorkerUploadBinding } from "./workerBindings";

export const W7S_RPC_BINDING = "W7S_RPC";
export const W7S_RPC_TOKEN_BINDING = "W7S_RPC_TOKEN";

const textEncoder = new TextEncoder();

const base64Url = (bytes: Uint8Array) => {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

export const generateRpcToken = () => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
};

export const hashRpcToken = async (token: string) => {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(token));
  return base64Url(new Uint8Array(digest));
};

export const buildRpcUploadBindings = (params: {
  env: Env;
  orgSlug: string;
  repoSlug: string;
  environment: string;
  token: string;
}): WorkerUploadBinding[] => [
  {
    type: "service",
    name: W7S_RPC_BINDING,
    service: params.env.W7S_WORKER_NAME?.trim() || "w7s-io",
    environment: "production"
  },
  {
    type: "secret_text",
    name: W7S_RPC_TOKEN_BINDING,
    text: params.token
  },
  {
    type: "plain_text",
    name: "W7S_OWNER",
    text: params.orgSlug
  },
  {
    type: "plain_text",
    name: "W7S_REPO",
    text: params.repoSlug
  },
  {
    type: "plain_text",
    name: "W7S_REPOSITORY",
    text: `${params.orgSlug}/${params.repoSlug}`
  },
  {
    type: "plain_text",
    name: "W7S_ENVIRONMENT",
    text: params.environment
  }
];
