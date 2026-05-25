import type { Env } from "./env";

export type AnalyticsEventName =
  | "deploy"
  | "runtime_request"
  | "runtime_showcase"
  | "rpc"
  | "queue_send"
  | "queue_delivery"
  | "schedule_delivery";

export type AnalyticsOutcome = "success" | "error";

export type AnalyticsEvent = {
  event: AnalyticsEventName;
  repository?: string | null;
  environment?: string | null;
  orgSlug?: string | null;
  repoSlug?: string | null;
  outcome?: AnalyticsOutcome | null;
  source?: string | null;
  target?: string | null;
  method?: string | null;
  status?: number | null;
  durationMs?: number | null;
  count?: number | null;
};

const blob = (value: string | null | undefined) =>
  value ? value.slice(0, 1024) : "";

const index = (value: string | null | undefined) =>
  blob(value || "w7s-core").slice(0, 96);

const number = (value: number | null | undefined) =>
  Number.isFinite(value) ? Number(value) : 0;

export const responseOutcome = (status: number): AnalyticsOutcome =>
  status >= 200 && status < 400 ? "success" : "error";

export const writeAnalyticsEvent = (env: Env, event: AnalyticsEvent) => {
  try {
    env.W7S_ANALYTICS?.writeDataPoint({
      indexes: [index(event.repository)],
      blobs: [
        blob(event.event),
        blob(event.repository),
        blob(event.environment),
        blob(event.orgSlug),
        blob(event.repoSlug),
        blob(event.outcome),
        blob(event.source),
        blob(event.target),
        blob(event.method)
      ],
      doubles: [
        number(event.count ?? 1),
        number(event.status),
        number(event.durationMs)
      ]
    });
  } catch {
    // Analytics must never change request behavior.
  }
};
