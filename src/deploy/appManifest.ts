import { normalizeArchivePath, readTextFile, type DeployArchive } from "./archive";

const BINDING_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type KvBindingDeclaration = {
  binding: string;
  name?: string;
};

export type R2BindingDeclaration = {
  binding: string;
  bucket?: string;
};

export type D1BindingDeclaration = {
  binding: string;
  name?: string;
  migrations?: string;
  jurisdiction?: "eu" | "fedramp";
  primaryLocationHint?: string;
};

export type AppManifest = {
  bindings: {
    kv: KvBindingDeclaration[];
    r2: R2BindingDeclaration[];
    d1: D1BindingDeclaration[];
  };
  vars: string[];
  secrets: string[];
  rpc: {
    allow: string[];
  };
};

const emptyManifest = (): AppManifest => ({
  bindings: {
    kv: [],
    r2: [],
    d1: []
  },
  vars: [],
  secrets: [],
  rpc: {
    allow: []
  }
});

const asRecord = (value: unknown, field: string) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const ensureBindingName = (value: unknown, field: string) => {
  if (typeof value !== "string" || !BINDING_NAME_PATTERN.test(value)) {
    throw new Error(`${field} must be a valid Worker binding name.`);
  }
  return value;
};

const optionalString = (value: unknown, field: string) => {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const trimmed = value.trim();
  return trimmed || undefined;
};

const parseKvBindings = (value: unknown): KvBindingDeclaration[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("bindings.kv must be an array.");
  return value.map((entry, index) => {
    if (typeof entry === "string") return { binding: ensureBindingName(entry, `bindings.kv[${index}]`) };
    const record = asRecord(entry, `bindings.kv[${index}]`);
    return {
      binding: ensureBindingName(record.binding, `bindings.kv[${index}].binding`),
      name: optionalString(record.name, `bindings.kv[${index}].name`)
    };
  });
};

const parseR2Bindings = (value: unknown): R2BindingDeclaration[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("bindings.r2 must be an array.");
  return value.map((entry, index) => {
    if (typeof entry === "string") return { binding: ensureBindingName(entry, `bindings.r2[${index}]`) };
    const record = asRecord(entry, `bindings.r2[${index}]`);
    return {
      binding: ensureBindingName(record.binding, `bindings.r2[${index}].binding`),
      bucket: optionalString(record.bucket ?? record.name, `bindings.r2[${index}].bucket`)
    };
  });
};

const parseD1Bindings = (value: unknown): D1BindingDeclaration[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("bindings.d1 must be an array.");
  return value.map((entry, index) => {
    if (typeof entry === "string") return { binding: ensureBindingName(entry, `bindings.d1[${index}]`) };
    const record = asRecord(entry, `bindings.d1[${index}]`);
    const jurisdiction = record.jurisdiction;
    if (jurisdiction !== undefined && jurisdiction !== "eu" && jurisdiction !== "fedramp") {
      throw new Error(`bindings.d1[${index}].jurisdiction must be eu or fedramp.`);
    }
    return {
      binding: ensureBindingName(record.binding, `bindings.d1[${index}].binding`),
      name: optionalString(record.name, `bindings.d1[${index}].name`),
      migrations: optionalString(record.migrations, `bindings.d1[${index}].migrations`),
      jurisdiction,
      primaryLocationHint: optionalString(record.primaryLocationHint ?? record.primary_location_hint, `bindings.d1[${index}].primaryLocationHint`)
    };
  });
};

const parseEnvNames = (value: unknown, field: string) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || !ENV_NAME_PATTERN.test(entry)) {
      throw new Error(`${field}[${index}] must be a valid environment variable name.`);
    }
    return entry;
  });
};

const parseRpcAllow = (value: unknown) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("rpc.allow must be an array.");
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`rpc.allow[${index}] must be a string.`);
    const normalized = entry.trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,99})(?:\/[a-z0-9](?:[a-z0-9._-]{0,99}))?$/i.test(normalized)) {
      throw new Error(`rpc.allow[${index}] must be a GitHub owner or owner/repo.`);
    }
    return normalized;
  });
};

const parseRpc = (value: unknown) => {
  if (value === undefined) return { allow: [] };
  const record = asRecord(value, "rpc");
  return {
    allow: parseRpcAllow(record.allow)
  };
};

export const readAppManifest = (archive: DeployArchive) => {
  const raw = readTextFile(archive, "w7s.json");
  if (!raw) return emptyManifest();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid w7s.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  const record = asRecord(parsed, "w7s.json");
  const bindings = record.bindings === undefined ? {} : asRecord(record.bindings, "bindings");
  return {
    bindings: {
      kv: parseKvBindings(bindings.kv),
      r2: parseR2Bindings(bindings.r2),
      d1: parseD1Bindings(bindings.d1)
    },
    vars: parseEnvNames(record.vars, "vars"),
    secrets: parseEnvNames(record.secrets, "secrets"),
    rpc: parseRpc(record.rpc)
  } satisfies AppManifest;
};

export const migrationFiles = (archive: DeployArchive, migrationsDir: string) => {
  const prefix = normalizeArchivePath(migrationsDir).replace(/\/+$/, "");
  if (!prefix || prefix.startsWith("../")) {
    throw new Error(`Invalid D1 migrations directory: ${migrationsDir}`);
  }
  return [...archive.files.keys()]
    .filter((path) => path.startsWith(`${prefix}/`) && path.toLowerCase().endsWith(".sql"))
    .sort();
};
