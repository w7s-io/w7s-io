import type { Env } from "../env";
import type { WorkerUploadBinding } from "./workerBindings";

export const W7S_QUEUE_BINDING = "W7S_QUEUE";
export const W7S_QUEUE_TOKEN_BINDING = "W7S_QUEUE_TOKEN";

export const buildQueueUploadBindings = (params: {
  env: Env;
  token: string;
}): WorkerUploadBinding[] => [
  {
    type: "service",
    name: W7S_QUEUE_BINDING,
    service: params.env.W7S_WORKER_NAME?.trim() || "w7s-io",
    environment: "production"
  },
  {
    type: "secret_text",
    name: W7S_QUEUE_TOKEN_BINDING,
    text: params.token
  }
];
