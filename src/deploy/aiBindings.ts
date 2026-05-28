import type { Env } from "../env";
import type { WorkerUploadBinding } from "./workerBindings";

export const W7S_AI_BINDING = "W7S_AI";

export const aiTokenBindingName = (binding: string) => `${binding}_TOKEN`;
export const aiCallerBindingName = (binding: string) => `${binding}_CALLER`;
export const aiEnvironmentBindingName = (binding: string) => `${binding}_ENVIRONMENT`;

export const buildAiUploadBindings = (params: {
  env: Env;
  binding: string;
  token: string;
  orgSlug: string;
  repoSlug: string;
  environment: string;
}): WorkerUploadBinding[] => [
  {
    type: "service",
    name: params.binding,
    service: params.env.W7S_WORKER_NAME?.trim() || "w7s-io",
    environment: "production"
  },
  {
    type: "secret_text",
    name: aiTokenBindingName(params.binding),
    text: params.token
  },
  {
    type: "plain_text",
    name: aiCallerBindingName(params.binding),
    text: `${params.orgSlug}/${params.repoSlug}`
  },
  {
    type: "plain_text",
    name: aiEnvironmentBindingName(params.binding),
    text: params.environment
  }
];
