import type { Env } from "../env";
import type { WorkerUploadBinding } from "./workerBindings";

export const W7S_WORKFLOW_BINDING = "W7S_WORKFLOW";
export const W7S_WORKFLOW_TOKEN_BINDING = "W7S_WORKFLOW_TOKEN";

export const buildWorkflowUploadBindings = (params: {
  env: Env;
  token: string;
}): WorkerUploadBinding[] => [
  {
    type: "service",
    name: W7S_WORKFLOW_BINDING,
    service: params.env.W7S_WORKER_NAME?.trim() || "w7s-io",
    environment: "production"
  },
  {
    type: "secret_text",
    name: W7S_WORKFLOW_TOKEN_BINDING,
    text: params.token
  }
];
