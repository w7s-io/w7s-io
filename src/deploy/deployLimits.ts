import { migrationFiles, type AppManifest } from "./appManifest";
import { readTextFile, type DeployArchive } from "./archive";
import { detectStaticSiteRoot } from "./staticPublisher";

const mb = (value: number) => value * 1024 * 1024;

export const DEPLOY_LIMITS = {
  archiveBytes: mb(25),
  uncompressedBytes: mb(100),
  staticFiles: 1_000,
  staticTotalBytes: mb(100),
  staticFileBytes: mb(10),
  kvBindings: 3,
  r2Bindings: 3,
  d1Bindings: 2,
  durableObjectClasses: 2,
  aiBindings: 1,
  queues: 2,
  schedules: 5,
  workflows: 5,
  customDomains: 3,
  d1MigrationFiles: 50,
  d1MigrationBytes: mb(5)
} as const;

const bytesLabel = (bytes: number) => `${Math.ceil(bytes / 1024 / 1024)} MB`;

const uniqueDurableObjectClasses = (manifest: AppManifest) =>
  new Set(manifest.bindings.durableObjects.map((entry) => entry.className)).size;

export const validateDeployLimits = (params: {
  archive: DeployArchive;
  manifest: AppManifest;
  customDomains: string[];
  allowAssetOnly?: boolean;
}) => {
  const errors: string[] = [];
  const { archive, manifest } = params;

  if (archive.compressedBytes > DEPLOY_LIMITS.archiveBytes) {
    errors.push(`Deploy archive exceeds ${bytesLabel(DEPLOY_LIMITS.archiveBytes)}.`);
  }
  if (archive.uncompressedBytes > DEPLOY_LIMITS.uncompressedBytes) {
    errors.push(`Deploy archive expands past ${bytesLabel(DEPLOY_LIMITS.uncompressedBytes)}.`);
  }
  if (manifest.bindings.kv.length > DEPLOY_LIMITS.kvBindings) {
    errors.push(`w7s.json declares more than ${DEPLOY_LIMITS.kvBindings} KV bindings.`);
  }
  if (manifest.bindings.r2.length > DEPLOY_LIMITS.r2Bindings) {
    errors.push(`w7s.json declares more than ${DEPLOY_LIMITS.r2Bindings} R2 bindings.`);
  }
  if (manifest.bindings.d1.length > DEPLOY_LIMITS.d1Bindings) {
    errors.push(`w7s.json declares more than ${DEPLOY_LIMITS.d1Bindings} D1 bindings.`);
  }
  if (uniqueDurableObjectClasses(manifest) > DEPLOY_LIMITS.durableObjectClasses) {
    errors.push(`w7s.json declares more than ${DEPLOY_LIMITS.durableObjectClasses} Durable Object classes.`);
  }
  if (manifest.bindings.ai.length > DEPLOY_LIMITS.aiBindings) {
    errors.push(`w7s.json declares more than ${DEPLOY_LIMITS.aiBindings} AI binding.`);
  }
  if (manifest.queues.length > DEPLOY_LIMITS.queues) {
    errors.push(`w7s.json declares more than ${DEPLOY_LIMITS.queues} queues.`);
  }
  if (manifest.schedules.length > DEPLOY_LIMITS.schedules) {
    errors.push(`w7s.json declares more than ${DEPLOY_LIMITS.schedules} schedules.`);
  }
  if (manifest.workflows.length > DEPLOY_LIMITS.workflows) {
    errors.push(`w7s.json declares more than ${DEPLOY_LIMITS.workflows} workflows.`);
  }
  if (params.customDomains.length > DEPLOY_LIMITS.customDomains) {
    errors.push(`CNAME declares more than ${DEPLOY_LIMITS.customDomains} custom domains.`);
  }

  const staticRoot = detectStaticSiteRoot(archive, {
    allowAssetOnly: params.allowAssetOnly
  });
  if (staticRoot) {
    const staticEntries = archive.entries.filter((entry) => {
      if (!entry.path.startsWith(staticRoot.prefix)) return false;
      return Boolean(entry.path.slice(staticRoot.prefix.length).replace(/^\/+/, ""));
    });
    const staticBytes = staticEntries.reduce((total, entry) => total + entry.bytes.byteLength, 0);
    if (staticEntries.length > DEPLOY_LIMITS.staticFiles) {
      errors.push(`Static output contains more than ${DEPLOY_LIMITS.staticFiles} files.`);
    }
    if (staticBytes > DEPLOY_LIMITS.staticTotalBytes) {
      errors.push(`Static output exceeds ${bytesLabel(DEPLOY_LIMITS.staticTotalBytes)}.`);
    }
    const largeFile = staticEntries.find((entry) => entry.bytes.byteLength > DEPLOY_LIMITS.staticFileBytes);
    if (largeFile) {
      errors.push(`Static file ${largeFile.path} exceeds ${bytesLabel(DEPLOY_LIMITS.staticFileBytes)}.`);
    }
  }

  for (const declaration of manifest.bindings.d1) {
    if (!declaration.migrations) continue;
    const files = migrationFiles(archive, declaration.migrations);
    const totalBytes = files.reduce((total, file) => {
      const text = readTextFile(archive, file) ?? "";
      return total + new TextEncoder().encode(text).byteLength;
    }, 0);
    if (files.length > DEPLOY_LIMITS.d1MigrationFiles) {
      errors.push(`D1 migrations for ${declaration.binding} contain more than ${DEPLOY_LIMITS.d1MigrationFiles} files.`);
    }
    if (totalBytes > DEPLOY_LIMITS.d1MigrationBytes) {
      errors.push(`D1 migrations for ${declaration.binding} exceed ${bytesLabel(DEPLOY_LIMITS.d1MigrationBytes)}.`);
    }
  }

  return errors;
};
