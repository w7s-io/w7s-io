import { afterEach, describe, expect, it, vi } from "vitest";
import {
  notifyAppSuspended,
  notifyDeployResponse,
  notifyTelegramManager
} from "../notifications";
import { app } from "../worker";
import { createTestEnv } from "./mocks";

const telegramEnv = () =>
  createTestEnv({
    W7S_TELEGRAM_BOT_TOKEN: "bot-token",
    W7S_TELEGRAM_CHAT_ID: "12345"
  });

const deployRequest = () =>
  new Request("https://w7s.cloud/api/v1/deploy", {
    method: "POST",
    headers: {
      "x-github-repository": "w7s-io/demo",
      "x-github-branch": "main",
      "x-github-sha": "abcdef1234567890"
    }
  });

const deployRequestWithTelegram = () =>
  new Request("https://w7s.cloud/api/v1/deploy", {
    method: "POST",
    headers: {
      "x-github-repository": "w7s-io/demo",
      "x-github-branch": "main",
      "x-github-sha": "abcdef1234567890",
      "x-w7s-telegram-chat-id": "55555",
      "x-w7s-telegram-events": "deploy_success,app_suspended,payment_request"
    }
  });

describe("Telegram notifications", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when Telegram is not fully configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await notifyTelegramManager(
      createTestEnv({ W7S_TELEGRAM_BOT_TOKEN: "bot-token" }),
      "deploy_success",
      "hello"
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends deployment warnings to the manager chat", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const env = telegramEnv();
    const response = Response.json({
      status: "success",
      data: {
        url: "https://demo.w7s.cloud/",
        deployment: {
          repository: "w7s-io/demo",
          environment: "production",
          branch: "main",
          commitSha: "abcdef1234567890",
          targets: {
            static: { fileCount: 2 },
            worker: { scriptName: "demo-worker" }
          }
        },
        deploymentWarnings: [
          {
            message: "backend/ was present, but W7S did not deploy a backend."
          }
        ]
      }
    });

    await notifyDeployResponse(env, deployRequest(), response);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.telegram.org/botbot-token/sendMessage");
    const body = JSON.parse(String(init.body)) as { chat_id: string; text: string };
    expect(body.chat_id).toBe("12345");
    expect(body.text).toContain("W7S deploy completed with warnings");
    expect(body.text).toContain("Repository: w7s-io/demo");
    expect(body.text).toContain("Targets: static 2 files, backend");
    expect(body.text).toContain("Deployment warnings: 1");
  });

  it("deduplicates repeated deploy error notifications", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const env = telegramEnv();
    const response = () =>
      Response.json(
        {
          status: "error",
          error: "Daily usage limit exceeded for deploy"
        },
        { status: 429 }
      );

    await notifyDeployResponse(env, deployRequest(), response());
    await notifyDeployResponse(env, deployRequest(), response());

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deduplicates app suspension notifications per repository day", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const env = telegramEnv();
    const params = {
      environment: "production",
      orgSlug: "w7s-io",
      repoSlug: "demo",
      reason: "W7S free-tier limit exceeded for runtime.request.",
      metrics: [
        {
          metric: "runtime.request",
          status: "exceeded" as const,
          used: 10_001,
          limit: 10_000,
          remaining: 0,
          message: "runtime.request exceeded the daily limit."
        }
      ],
      resumeAfter: "2026-05-29T00:00:00.000Z",
      at: new Date("2026-05-28T12:00:00.000Z")
    };

    await notifyAppSuspended(env, params);
    await notifyAppSuspended(env, params);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { text: string };
    expect(body.text).toContain("W7S app suspended");
    expect(body.text).toContain("Repository: w7s-io/demo");
    expect(body.text).toContain("runtime.request: 10001/10000");
  });

  it("links a deploy action Telegram chat id to future repo alerts", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const env = createTestEnv({
      W7S_TELEGRAM_BOT_TOKEN: "bot-token"
    });
    const response = Response.json({
      status: "success",
      data: {
        url: "https://demo.w7s.cloud/",
        deployment: {
          orgSlug: "w7s-io",
          repoSlug: "demo",
          repository: "w7s-io/demo",
          environment: "production",
          branch: "main",
          commitSha: "abcdef1234567890",
          targets: {
            static: { fileCount: 2 }
          }
        }
      }
    });

    await notifyDeployResponse(env, deployRequestWithTelegram(), response);
    await notifyAppSuspended(env, {
      environment: "production",
      orgSlug: "w7s-io",
      repoSlug: "demo",
      reason: "W7S free-tier limit exceeded.",
      at: new Date("2026-05-28T12:00:00.000Z")
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { chat_id: string; text: string };
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body)) as { chat_id: string; text: string };
    expect(firstBody.chat_id).toBe("55555");
    expect(firstBody.text).toContain("W7S deploy succeeded");
    expect(secondBody.chat_id).toBe("55555");
    expect(secondBody.text).toContain("W7S app suspended");
  });

  it("handles Telegram webhook updates with setup instructions", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const env = createTestEnv({
      W7S_TELEGRAM_BOT_TOKEN: "bot-token",
      W7S_TELEGRAM_WEBHOOK_SECRET: "secret"
    });

    const response = await app.fetch(
      new Request("https://w7s.cloud/api/v1/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "secret"
        },
        body: JSON.stringify({
          message: {
            text: "/start",
            chat: { id: 77777, type: "private" },
            from: { id: 77777, username: "demo" }
          }
        })
      }),
      env
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as { chat_id: string; text: string; parse_mode?: string };
    expect(body.chat_id).toBe("77777");
    expect(body.parse_mode).toBe("Markdown");
    expect(body.text).toContain('```\ntelegram-chat-id: "77777"\n```');
    expect(body.text).toContain('telegram-chat-id: "77777"');
    expect(body.text).toContain("w7s-io/w7s-cloud@v1");
  });
});
