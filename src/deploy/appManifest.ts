import { normalizeArchivePath, readTextFile, type DeployArchive } from "./archive";
import { normalizeCronExpression } from "../cron";

const BINDING_NAME_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUEUE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,99})$/i;

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

export type DurableObjectBindingDeclaration = {
  binding: string;
  className: string;
};

export type HyperdriveBindingDeclaration = {
  binding: string;
  id: string;
};

export type QueueDeclaration = {
  name: string;
  consumer: string;
};

export type ScheduleDeclaration = {
  cron: string;
  path: string;
};

export type AppManifest = {
  bindings: {
    kv: KvBindingDeclaration[];
    r2: R2BindingDeclaration[];
    d1: D1BindingDeclaration[];
    durableObjects: DurableObjectBindingDeclaration[];
    hyperdrive: HyperdriveBindingDeclaration[];
  };
  queues: QueueDeclaration[];
  schedules: ScheduleDeclaration[];
  vars: string[];
  secrets: string[];
  queue: {
    allow: string[];
  };
  rpc: {
    allow: string[];
  };
};

const emptyManifest = (): AppManifest => ({
  bindings: {
    kv: [],
    r2: [],
    d1: [],
    durableObjects: [],
    hyperdrive: []
  },
  queues: [],
  schedules: [],
  vars: [],
  secrets: [],
  queue: {
    allow: []
  },
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

const ensureQueueName = (value: unknown, field: string) => {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const normalized = value.trim().toLowerCase();
  if (!QUEUE_NAME_PATTERN.test(normalized)) {
    throw new Error(`${field} must be a valid queue name.`);
  }
  return normalized;
};

const ensureConsumerPath = (value: unknown, field: string, queueName: string) => {
  if (value === undefined) return `/_w7s/queues/${queueName}`;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    throw new Error(`${field} must be an absolute path.`);
  }
  return trimmed;
};

const ensureClassName = (value: unknown, field: string) => {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const trimmed = value.trim();
  if (!BINDING_NAME_PATTERN.test(trimmed)) throw new Error(`${field} must be a JavaScript class name.`);
  return trimmed;
};

const ensureNonEmptyString = (value: unknown, field: string) => {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} must not be empty.`);
  return trimmed;
};

const ensureSchedulePath = (value: unknown, field: string) => {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    throw new Error(`${field} must be an absolute path.`);
  }
  return trimmed;
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

const parseDurableObjectBindings = (value: unknown): DurableObjectBindingDeclaration[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("bindings.durableObjects must be an array.");
  const seenBindings = new Set<string>();
  return value.map((entry, index) => {
    const declaration =
      typeof entry === "string"
        ? {
            binding: ensureBindingName(entry, `bindings.durableObjects[${index}]`),
            className: ensureClassName(entry, `bindings.durableObjects[${index}]`)
          }
        : (() => {
            const record = asRecord(entry, `bindings.durableObjects[${index}]`);
            return {
              binding: ensureBindingName(record.binding, `bindings.durableObjects[${index}].binding`),
              className: ensureClassName(record.className ?? record.class_name, `bindings.durableObjects[${index}].className`)
            };
          })();
    if (seenBindings.has(declaration.binding)) {
      throw new Error(`bindings.durableObjects[${index}].binding duplicates ${declaration.binding}.`);
    }
    seenBindings.add(declaration.binding);
    return declaration;
  });
};

const parseHyperdriveBindings = (value: unknown): HyperdriveBindingDeclaration[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("bindings.hyperdrive must be an array.");
  const seenBindings = new Set<string>();
  return value.map((entry, index) => {
    const record = asRecord(entry, `bindings.hyperdrive[${index}]`);
    const declaration = {
      binding: ensureBindingName(record.binding, `bindings.hyperdrive[${index}].binding`),
      id: ensureNonEmptyString(record.id, `bindings.hyperdrive[${index}].id`)
    };
    if (seenBindings.has(declaration.binding)) {
      throw new Error(`bindings.hyperdrive[${index}].binding duplicates ${declaration.binding}.`);
    }
    seenBindings.add(declaration.binding);
    return declaration;
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

const parseGitHubAllowList = (value: unknown, field: string) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array.`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`${field}[${index}] must be a string.`);
    const normalized = entry.trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9._-]{0,99})(?:\/[a-z0-9](?:[a-z0-9._-]{0,99}))?$/i.test(normalized)) {
      throw new Error(`${field}[${index}] must be a GitHub owner or owner/repo.`);
    }
    return normalized;
  });
};

const parseQueues = (value: unknown): QueueDeclaration[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("queues must be an array.");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    let declaration: QueueDeclaration;
    if (typeof entry === "string") {
      const name = ensureQueueName(entry, `queues[${index}]`);
      declaration = {
        name,
        consumer: `/_w7s/queues/${name}`
      };
    } else {
      const record = asRecord(entry, `queues[${index}]`);
      const name = ensureQueueName(record.name, `queues[${index}].name`);
      declaration = {
        name,
        consumer: ensureConsumerPath(record.consumer, `queues[${index}].consumer`, name)
      };
    }
    if (seen.has(declaration.name)) throw new Error(`queues[${index}] duplicates ${declaration.name}.`);
    seen.add(declaration.name);
    return declaration;
  });
};

const parseSchedules = (value: unknown): ScheduleDeclaration[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("schedules must be an array.");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const record = asRecord(entry, `schedules[${index}]`);
    if (typeof record.cron !== "string") {
      throw new Error(`schedules[${index}].cron must be a string.`);
    }
    const declaration = {
      cron: normalizeCronExpression(record.cron),
      path: ensureSchedulePath(record.path, `schedules[${index}].path`)
    };
    const key = `${declaration.cron}\0${declaration.path}`;
    if (seen.has(key)) throw new Error(`schedules[${index}] duplicates ${declaration.cron} ${declaration.path}.`);
    seen.add(key);
    return declaration;
  });
};

const parseQueue = (value: unknown) => {
  if (value === undefined) return { allow: [] };
  const record = asRecord(value, "queue");
  return {
    allow: parseGitHubAllowList(record.allow, "queue.allow")
  };
};

const parseRpc = (value: unknown) => {
  if (value === undefined) return { allow: [] };
  const record = asRecord(value, "rpc");
  return {
    allow: parseGitHubAllowList(record.allow, "rpc.allow")
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
      d1: parseD1Bindings(bindings.d1),
      durableObjects: parseDurableObjectBindings(bindings.durableObjects ?? bindings.durable_objects),
      hyperdrive: parseHyperdriveBindings(bindings.hyperdrive)
    },
    queues: parseQueues(record.queues),
    schedules: parseSchedules(record.schedules),
    vars: parseEnvNames(record.vars, "vars"),
    secrets: parseEnvNames(record.secrets, "secrets"),
    queue: parseQueue(record.queue),
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
