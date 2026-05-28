import type { Env } from "../env";
import type { WorkerUploadBinding } from "./workerBindings";

export const W7S_AI_BINDING = "W7S_AI";
export const W7S_AI_TOKEN_BINDING = "W7S_AI_TOKEN";

export const buildAiUploadBindings = (params: {
  env: Env;
  token: string;
}): WorkerUploadBinding[] => [
  {
    type: "service",
    name: W7S_AI_BINDING,
    service: params.env.W7S_WORKER_NAME?.trim() || "w7s-io",
    environment: "production"
  },
  {
    type: "secret_text",
    name: W7S_AI_TOKEN_BINDING,
    text: params.token
  }
];
