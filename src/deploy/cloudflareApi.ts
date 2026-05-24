import type { Env } from "../env";

export type CloudflareEnvelope<T> = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: T;
};

export const buildCloudflareHeaders = (apiToken: string, contentType?: string) => ({
  authorization: `Bearer ${apiToken}`,
  ...(contentType ? { "content-type": contentType } : {})
});

export const parseCloudflareEnvelope = async <T>(response: Response) => {
  const text = await response.text();
  let parsed: CloudflareEnvelope<T> | null = null;
  try {
    parsed = text ? (JSON.parse(text) as CloudflareEnvelope<T>) : null;
  } catch {
    parsed = null;
  }
  if (response.ok && parsed?.success !== false) {
    return parsed?.result ?? null;
  }
  const message = parsed?.errors?.map((entry) => entry.message?.trim()).filter(Boolean).join("; ");
  throw new Error(message || text || `Cloudflare API request failed (${response.status}).`);
};

const asNonEmptyString = (value: unknown) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const requireCloudflareCredentials = (env: Env) => {
  const apiToken = asNonEmptyString(env.CLOUDFLARE_API_TOKEN);
  const accountId = asNonEmptyString(env.CLOUDFLARE_ACCOUNT_ID);
  if (!apiToken || !accountId) {
    throw new Error("Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to publish Workers or provision app storage.");
  }
  return { apiToken, accountId };
};

export const optionalCloudflareString = asNonEmptyString;
