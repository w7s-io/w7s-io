import type { Env } from "../env";
import { sanitizeScriptPart } from "../names";
import type { DeployArchive } from "./archive";
import { readTextFile } from "./archive";
import type {
  AppManifest,
  D1BindingDeclaration,
  DurableObjectBindingDeclaration,
  HyperdriveBindingDeclaration,
  KvBindingDeclaration,
  R2BindingDeclaration
} from "./appManifest";
import { migrationFiles } from "./appManifest";
import type { DeployValues } from "./deployValues";
import type { WorkerUploadBinding } from "./workerBindings";
import {
  buildCloudflareHeaders,
  parseCloudflareEnvelope,
  requireCloudflareCredentials
} from "./cloudflareApi";
import {
  loadManagedResourceRecord,
  storeManagedResourceRecord,
  type DeploymentBindings,
  type ManagedResourceKind,
  type ManagedResourceRecord
} from "../storage/deployments";

type ProvisionParams = {
  env: Env;
  archive: DeployArchive;
  manifest: AppManifest;
  deployValues: DeployValues;
  orgSlug: string;
  repoSlug: string;
  environment: string;
};

type CloudflareCredentials = ReturnType<typeof requireCloudflareCredentials>;

type KvNamespace = {
  id?: string;
  title?: string;
};

type D1Database = {
  uuid?: string;
  name?: string;
};

type D1QueryResult = {
  success?: boolean;
  results?: Array<Record<string, unknown>>;
  error?: string;
};

export type DurableObjectMigrationPlan = {
  classNames: string[];
  newClassNames: string[];
  newTag: string;
};

const hasStorageBindings = (manifest: AppManifest) =>
  manifest.bindings.kv.length > 0 ||
  manifest.bindings.r2.length > 0 ||
  manifest.bindings.d1.length > 0;

const hasRuntimeBindings = (manifest: AppManifest, deployValues: DeployValues) =>
  hasStorageBindings(manifest) ||
  manifest.bindings.durableObjects.length > 0 ||
  manifest.bindings.hyperdrive.length > 0 ||
  Object.keys(deployValues.vars).length > 0 ||
  Object.keys(deployValues.secrets).length > 0;

const shortHash = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(7, "0").slice(0, 7);
};

const compactR2Name = (name: string) => {
  if (name.length <= 63) return name;
  const suffix = shortHash(name);
  return `${name.slice(0, 55).replace(/-+$/g, "")}-${suffix}`;
};

const defaultResourceName = (
  kind: ManagedResourceKind,
  orgSlug: string,
  repoSlug: string,
  environment: string,
  binding: string
) => {
  const name = [
    "w7s",
    sanitizeScriptPart(environment),
    sanitizeScriptPart(orgSlug),
    sanitizeScriptPart(repoSlug),
    kind,
    sanitizeScriptPart(binding)
  ].join("-");
  return kind === "r2" ? compactR2Name(name) : name;
};

const recordFor = (params: {
  kind: ManagedResourceKind;
  orgSlug: string;
  repoSlug: string;
  environment: string;
  binding: string;
  name: string;
  id: string;
}) => {
  const now = new Date().toISOString();
  return {
    version: 1,
    kind: params.kind,
    orgSlug: params.orgSlug,
    repoSlug: params.repoSlug,
    environment: params.environment,
    binding: params.binding,
    name: params.name,
    id: params.id,
    createdAt: now,
    updatedAt: now
  } satisfies ManagedResourceRecord;
};

const getOrCreateManagedRecord = async (params: {
  env: Env;
  credentials: CloudflareCredentials;
  kind: ManagedResourceKind;
  orgSlug: string;
  repoSlug: string;
  environment: string;
  binding: string;
  name: string;
  create: () => Promise<string>;
}) => {
  const existing = await loadManagedResourceRecord(
    params.env,
    params.environment,
    params.orgSlug,
    params.repoSlug,
    params.kind,
    params.binding
  );
  if (existing) return existing;

  const id = await params.create();
  const record = recordFor({
    kind: params.kind,
    orgSlug: params.orgSlug,
    repoSlug: params.repoSlug,
    environment: params.environment,
    binding: params.binding,
    name: params.name,
    id
  });
  await storeManagedResourceRecord(params.env, record);
  return record;
};

const findOrCreateKvNamespace = async (
  credentials: CloudflareCredentials,
  title: string
) => {
  const listResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/storage/kv/namespaces?per_page=1000`,
    {
      headers: buildCloudflareHeaders(credentials.apiToken)
    }
  );
  const namespaces = await parseCloudflareEnvelope<KvNamespace[]>(listResponse);
  const existing = namespaces?.find((namespace) => namespace.title === title);
  if (existing?.id) return existing.id;

  const createResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/storage/kv/namespaces`,
    {
      method: "POST",
      headers: buildCloudflareHeaders(credentials.apiToken, "application/json"),
      body: JSON.stringify({ title })
    }
  );
  const created = await parseCloudflareEnvelope<KvNamespace>(createResponse);
  if (!created?.id) throw new Error(`Cloudflare did not return a KV namespace id for ${title}.`);
  return created.id;
};

const findOrCreateR2Bucket = async (
  credentials: CloudflareCredentials,
  bucketName: string
) => {
  const getResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/r2/buckets/${encodeURIComponent(bucketName)}`,
    {
      headers: buildCloudflareHeaders(credentials.apiToken)
    }
  );
  if (getResponse.ok) {
    await parseCloudflareEnvelope(getResponse);
    return bucketName;
  }
  if (getResponse.status !== 404) {
    await parseCloudflareEnvelope(getResponse);
  }

  const createResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/r2/buckets`,
    {
      method: "POST",
      headers: buildCloudflareHeaders(credentials.apiToken, "application/json"),
      body: JSON.stringify({ name: bucketName })
    }
  );
  await parseCloudflareEnvelope(createResponse);
  return bucketName;
};

const findOrCreateD1Database = async (
  credentials: CloudflareCredentials,
  declaration: D1BindingDeclaration,
  name: string
) => {
  const listResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/d1/database?name=${encodeURIComponent(name)}&per_page=100`,
    {
      headers: buildCloudflareHeaders(credentials.apiToken)
    }
  );
  const databases = await parseCloudflareEnvelope<D1Database[]>(listResponse);
  const existing = databases?.find((database) => database.name === name);
  if (existing?.uuid) return existing.uuid;

  const createBody = {
    name,
    ...(declaration.jurisdiction ? { jurisdiction: declaration.jurisdiction } : {}),
    ...(declaration.primaryLocationHint ? { primary_location_hint: declaration.primaryLocationHint } : {})
  };
  const createResponse = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/d1/database`,
    {
      method: "POST",
      headers: buildCloudflareHeaders(credentials.apiToken, "application/json"),
      body: JSON.stringify(createBody)
    }
  );
  const created = await parseCloudflareEnvelope<D1Database>(createResponse);
  if (!created?.uuid) throw new Error(`Cloudflare did not return a D1 database id for ${name}.`);
  return created.uuid;
};

const executeD1Query = async (
  credentials: CloudflareCredentials,
  databaseId: string,
  sql: string,
  params?: string[]
) => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(credentials.accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
    {
      method: "POST",
      headers: buildCloudflareHeaders(credentials.apiToken, "application/json"),
      body: JSON.stringify({
        sql,
        ...(params ? { params } : {})
      })
    }
  );
  const results = await parseCloudflareEnvelope<D1QueryResult[]>(response);
  const failed = results?.find((result) => result.success === false);
  if (failed) throw new Error(failed.error || "D1 query failed.");
  return results ?? [];
};

const applyD1Migrations = async (params: {
  credentials: CloudflareCredentials;
  archive: DeployArchive;
  databaseId: string;
  migrationsDir?: string;
}) => {
  if (!params.migrationsDir) return 0;
  const files = migrationFiles(params.archive, params.migrationsDir);
  if (files.length === 0) return 0;

  await executeD1Query(
    params.credentials,
    params.databaseId,
    "CREATE TABLE IF NOT EXISTS _w7s_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)"
  );

  let applied = 0;
  for (const file of files) {
    const existing = await executeD1Query(
      params.credentials,
      params.databaseId,
      "SELECT name FROM _w7s_migrations WHERE name = ?",
      [file]
    );
    if ((existing[0]?.results?.length ?? 0) > 0) continue;

    const sql = readTextFile(params.archive, file);
    if (!sql?.trim()) continue;
    await executeD1Query(params.credentials, params.databaseId, sql);
    await executeD1Query(
      params.credentials,
      params.databaseId,
      "INSERT INTO _w7s_migrations (name, applied_at) VALUES (?, ?)",
      [file, new Date().toISOString()]
    );
    applied += 1;
  }
  return applied;
};

const collectRuntimeValues = (params: {
  manifest: AppManifest;
  deployValues: DeployValues;
}) => {
  const uploadBindings: WorkerUploadBinding[] = [];
  const vars: string[] = [];
  const secrets: string[] = [];
  const varNames = new Set([
    ...params.manifest.vars,
    ...Object.keys(params.deployValues.vars)
  ]);
  const secretNames = new Set([
    ...params.manifest.secrets,
    ...Object.keys(params.deployValues.secrets)
  ]);

  for (const name of varNames) {
    if (!Object.prototype.hasOwnProperty.call(params.deployValues.vars, name)) continue;
    uploadBindings.push({
      type: "plain_text",
      name,
      text: params.deployValues.vars[name] ?? ""
    });
    vars.push(name);
  }

  for (const name of secretNames) {
    if (!Object.prototype.hasOwnProperty.call(params.deployValues.secrets, name)) continue;
    uploadBindings.push({
      type: "secret_text",
      name,
      text: params.deployValues.secrets[name] ?? ""
    });
    secrets.push(name);
  }

  return { uploadBindings, vars, secrets };
};

const kvName = (
  declaration: KvBindingDeclaration,
  orgSlug: string,
  repoSlug: string,
  environment: string
) =>
  declaration.name ?? defaultResourceName("kv", orgSlug, repoSlug, environment, declaration.binding);

const r2Name = (
  declaration: R2BindingDeclaration,
  orgSlug: string,
  repoSlug: string,
  environment: string
) =>
  declaration.bucket ?? defaultResourceName("r2", orgSlug, repoSlug, environment, declaration.binding);

const d1Name = (
  declaration: D1BindingDeclaration,
  orgSlug: string,
  repoSlug: string,
  environment: string
) =>
  declaration.name ?? defaultResourceName("d1", orgSlug, repoSlug, environment, declaration.binding);

const hyperdriveBinding = (declaration: HyperdriveBindingDeclaration): WorkerUploadBinding => ({
  type: "hyperdrive",
  name: declaration.binding,
  id: declaration.id
});

const uniqueSortedClassNames = (declarations: DurableObjectBindingDeclaration[]) =>
  [...new Set(declarations.map((declaration) => declaration.className))].sort();

const durableObjectMigrationTag = (classNames: string[]) =>
  `w7s-do-${shortHash(classNames.join("\0"))}`;

export const storeDurableObjectClassRecords = async (params: {
  env: Env;
  orgSlug: string;
  repoSlug: string;
  environment: string;
  classNames: string[];
}) => {
  const now = new Date().toISOString();
  await Promise.all(
    params.classNames.map(async (className) => {
      const existing = await loadManagedResourceRecord(
        params.env,
        params.environment,
        params.orgSlug,
        params.repoSlug,
        "durable_object",
        className
      );
      await storeManagedResourceRecord(params.env, {
        version: 1,
        kind: "durable_object",
        orgSlug: params.orgSlug,
        repoSlug: params.repoSlug,
        environment: params.environment,
        binding: className,
        name: className,
        id: className,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      });
    })
  );
};

export const provisionAppBindings = async (params: ProvisionParams) => {
  const valueBindings = collectRuntimeValues(params);
  if (!hasRuntimeBindings(params.manifest, params.deployValues)) {
    return {
      uploadBindings: [],
      deploymentBindings: undefined,
      durableObjectMigrations: undefined
    };
  }

  const uploadBindings: WorkerUploadBinding[] = [...valueBindings.uploadBindings];
  const deploymentBindings: DeploymentBindings = {};
  const credentials = hasStorageBindings(params.manifest)
    ? requireCloudflareCredentials(params.env)
    : null;

  for (const declaration of params.manifest.bindings.kv) {
    const name = kvName(declaration, params.orgSlug, params.repoSlug, params.environment);
    const record = await getOrCreateManagedRecord({
      env: params.env,
      credentials: credentials!,
      kind: "kv",
      orgSlug: params.orgSlug,
      repoSlug: params.repoSlug,
      environment: params.environment,
      binding: declaration.binding,
      name,
      create: () => findOrCreateKvNamespace(credentials!, name)
    });
    uploadBindings.push({
      type: "kv_namespace",
      name: declaration.binding,
      namespace_id: record.id
    });
    deploymentBindings.kv ??= [];
    deploymentBindings.kv.push({
      binding: declaration.binding,
      name: record.name,
      namespaceId: record.id
    });
  }

  for (const declaration of params.manifest.bindings.r2) {
    const name = r2Name(declaration, params.orgSlug, params.repoSlug, params.environment);
    const record = await getOrCreateManagedRecord({
      env: params.env,
      credentials: credentials!,
      kind: "r2",
      orgSlug: params.orgSlug,
      repoSlug: params.repoSlug,
      environment: params.environment,
      binding: declaration.binding,
      name,
      create: () => findOrCreateR2Bucket(credentials!, name)
    });
    uploadBindings.push({
      type: "r2_bucket",
      name: declaration.binding,
      bucket_name: record.name
    });
    deploymentBindings.r2 ??= [];
    deploymentBindings.r2.push({
      binding: declaration.binding,
      bucketName: record.name
    });
  }

  for (const declaration of params.manifest.bindings.d1) {
    const name = d1Name(declaration, params.orgSlug, params.repoSlug, params.environment);
    const record = await getOrCreateManagedRecord({
      env: params.env,
      credentials: credentials!,
      kind: "d1",
      orgSlug: params.orgSlug,
      repoSlug: params.repoSlug,
      environment: params.environment,
      binding: declaration.binding,
      name,
      create: () => findOrCreateD1Database(credentials!, declaration, name)
    });
    const migrationsApplied = await applyD1Migrations({
      credentials: credentials!,
      archive: params.archive,
      databaseId: record.id,
      migrationsDir: declaration.migrations
    });
    uploadBindings.push({
      type: "d1",
      name: declaration.binding,
      id: record.id
    });
    deploymentBindings.d1 ??= [];
    deploymentBindings.d1.push({
      binding: declaration.binding,
      name: record.name,
      databaseId: record.id,
      ...(migrationsApplied > 0 ? { migrationsApplied } : {})
    });
  }

  for (const declaration of params.manifest.bindings.hyperdrive) {
    uploadBindings.push(hyperdriveBinding(declaration));
    deploymentBindings.hyperdrive ??= [];
    deploymentBindings.hyperdrive.push({
      binding: declaration.binding,
      id: declaration.id
    });
  }

  const durableObjectClassNames = uniqueSortedClassNames(params.manifest.bindings.durableObjects);
  const newDurableObjectClassNames: string[] = [];
  for (const declaration of params.manifest.bindings.durableObjects) {
    uploadBindings.push({
      type: "durable_object_namespace",
      name: declaration.binding,
      class_name: declaration.className
    });
    deploymentBindings.durableObjects ??= [];
    deploymentBindings.durableObjects.push({
      binding: declaration.binding,
      className: declaration.className
    });
  }
  for (const className of durableObjectClassNames) {
    const existing = await loadManagedResourceRecord(
      params.env,
      params.environment,
      params.orgSlug,
      params.repoSlug,
      "durable_object",
      className
    );
    if (!existing) newDurableObjectClassNames.push(className);
  }

  if (valueBindings.vars.length > 0) deploymentBindings.vars = valueBindings.vars;
  if (valueBindings.secrets.length > 0) deploymentBindings.secrets = valueBindings.secrets;

  return {
    uploadBindings,
    deploymentBindings,
    durableObjectMigrations:
      durableObjectClassNames.length > 0
        ? {
            classNames: durableObjectClassNames,
            newClassNames: newDurableObjectClassNames,
            newTag: durableObjectMigrationTag(durableObjectClassNames)
          }
        : undefined
  };
};
