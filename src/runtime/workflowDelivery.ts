import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { responseOutcome, writeAnalyticsEvent } from "../analytics";
import type { Env, W7SWorkflowPayload } from "../env";
import { loadDeploymentRecord } from "../storage/deployments";
import { recordUsageEvent } from "../usage";
import { checkBlockedUsageLimit, costGuardExceededMessage } from "../usageEnforcement";
import { clearActiveWorkflow } from "../workflowLimits";
import { dispatchWorker } from "./dispatch";

const MAX_RESPONSE_BODY_LENGTH = 65_536;

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const assertPayload = (payload: unknown): W7SWorkflowPayload => {
  if (!payload || typeof payload !== "object" || (payload as W7SWorkflowPayload).version !== 1) {
    throw new Error("Invalid W7S workflow payload.");
  }
  return payload as W7SWorkflowPayload;
};

export class W7SWorkflow extends WorkflowEntrypoint<Env, W7SWorkflowPayload> {
  async run(event: WorkflowEvent<W7SWorkflowPayload>, step: WorkflowStep) {
    const payload = assertPayload(event.payload);
    const startedAt = Date.now();

    try {
      return await step.do(
        "dispatch workflow consumer",
        {
          retries: {
            limit: positiveInteger(this.env.W7S_WORKFLOW_MAX_RETRIES, 3),
            delay: `${positiveInteger(this.env.W7S_WORKFLOW_RETRY_DELAY_SECONDS, 10)} seconds`,
            backoff: "exponential"
          },
          timeout: `${positiveInteger(this.env.W7S_WORKFLOW_TIMEOUT_SECONDS, 300)} seconds`
        },
        async () => {
          const deployment = await loadDeploymentRecord(
            this.env,
            payload.target.environment,
            payload.target.orgSlug,
            payload.target.repoSlug
          );
          const workerTarget = deployment?.targets.worker;
          if (!deployment || !workerTarget) {
            throw new Error(`W7S workflow target deployment was not found for ${payload.target.repository}.`);
          }

          const blocked = await checkBlockedUsageLimit(this.env, {
            metric: "workflow.delivery",
            environment: payload.target.environment,
            orgSlug: payload.target.orgSlug,
            repoSlug: payload.target.repoSlug,
            units: 1
          });
          if (blocked) {
            writeAnalyticsEvent(this.env, {
              event: "workflow_delivery",
              repository: payload.target.repository,
              environment: payload.target.environment,
              orgSlug: payload.target.orgSlug,
              repoSlug: payload.target.repoSlug,
              outcome: "error",
              source: payload.target.workflow,
              target: payload.caller.repository,
              method: "POST",
              status: 429,
              durationMs: Date.now() - startedAt,
              count: 1
            });
            return {
              status: 429,
              contentType: "application/json; charset=utf-8",
              body: JSON.stringify({
                status: "error",
                error: costGuardExceededMessage(blocked),
                details: {
                  usageLimit: blocked
                }
              }).slice(0, MAX_RESPONSE_BODY_LENGTH)
            };
          }

          const request = new Request(`https://${payload.target.orgSlug}.w7s.internal${payload.target.path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json"
            },
            body: JSON.stringify({
              workflow: payload.target.workflow,
              workflowName: payload.target.workflow,
              instanceId: event.instanceId,
              createdAt: payload.createdAt,
              caller: payload.caller,
              target: payload.target,
              payload: payload.payload
            })
          });

          const response = await dispatchWorker({
            env: this.env,
            request,
            repoPath: payload.target.path,
            repoSlug: payload.target.repoSlug,
            orgSlug: payload.target.orgSlug,
            scriptName: workerTarget.scriptName,
            urlHost: `${payload.target.orgSlug}.w7s.internal`,
            headers: {
              "x-w7s-workflow": "1",
              "x-w7s-workflow-name": payload.target.workflow,
              "x-w7s-workflow-instance": event.instanceId
            }
          });
          const responseBody = await response.text();

          writeAnalyticsEvent(this.env, {
            event: "workflow_delivery",
            repository: payload.target.repository,
            environment: payload.target.environment,
            orgSlug: payload.target.orgSlug,
            repoSlug: payload.target.repoSlug,
            outcome: responseOutcome(response.status),
            source: payload.target.workflow,
            target: payload.caller.repository,
            method: "POST",
            status: response.status,
            durationMs: Date.now() - startedAt,
            count: 1
          });
          await recordUsageEvent(this.env, {
            metric: "workflow.delivery",
            repository: payload.target.repository,
            environment: payload.target.environment,
            orgSlug: payload.target.orgSlug,
            repoSlug: payload.target.repoSlug,
            outcome: responseOutcome(response.status),
            count: 1,
            units: 1
          });

          if (response.status < 200 || response.status >= 300) {
            throw new Error(`W7S workflow consumer failed with HTTP ${response.status}.`);
          }

          return {
            status: response.status,
            contentType: response.headers.get("content-type") ?? "",
            body: responseBody.slice(0, MAX_RESPONSE_BODY_LENGTH)
          };
        }
      );
    } finally {
      await clearActiveWorkflow(this.env, {
        environment: payload.target.environment,
        orgSlug: payload.target.orgSlug,
        repoSlug: payload.target.repoSlug,
        workflow: payload.target.workflow,
        instanceId: event.instanceId
      });
    }
  }
}
