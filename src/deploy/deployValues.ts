import type { Context } from "hono";
import type { Env } from "../env";

type HonoContext = Context<{ Bindings: Env }>;

export type DeployValues = {
  vars: Record<string, string>;
  secrets: Record<string, string>;
};

const decodeBase64Url = (value: string) => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return atob(padded);
};

const parseHeaderObject = (c: HonoContext, name: string) => {
  const header = c.req.header(name)?.trim();
  if (!header) return {};
  let decoded: string;
  try {
    decoded = decodeBase64Url(header);
  } catch {
    throw new Error(`${name} must be base64url-encoded JSON.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch (error) {
    throw new Error(`${name} must contain JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must decode to an object.`);
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`${name} contains invalid environment variable name ${key}.`);
    }
    if (typeof value !== "string") {
      throw new Error(`${name}.${key} must be a string.`);
    }
    values[key] = value;
  }
  return values;
};

export const readDeployValues = (c: HonoContext): DeployValues => ({
  vars: parseHeaderObject(c, "x-w7s-vars"),
  secrets: parseHeaderObject(c, "x-w7s-secrets")
});
