import { unzipSync } from "fflate";

export type ArchiveEntry = {
  path: string;
  bytes: Uint8Array;
};

export type DeployArchive = {
  entries: ArchiveEntry[];
  files: Map<string, Uint8Array>;
  compressedBytes: number;
  uncompressedBytes: number;
};

const textDecoder = new TextDecoder();

export const normalizeArchivePath = (value: string) => {
  const parts: string[] = [];
  value
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .split("/")
    .forEach((part) => {
      if (!part || part === ".") return;
      if (part === "..") {
        parts.pop();
        return;
      }
      parts.push(part);
    });
  return parts.join("/");
};

const stripCommonRoot = (entries: ArchiveEntry[]) => {
  const platformRoots = new Set([
    "worker",
    "frontend",
    "backend",
    "dist",
    "build",
    "out",
    "db",
    ".github"
  ]);
  const topLevels = new Set<string>();
  let allNested = entries.length > 0;
  for (const entry of entries) {
    const parts = entry.path.split("/");
    if (parts.length < 2) {
      allNested = false;
      break;
    }
    topLevels.add(parts[0] ?? "");
  }
  if (!allNested || topLevels.size !== 1) return entries;
  const root = [...topLevels][0] ?? "";
  if (platformRoots.has(root)) return entries;
  if (!root) return entries;
  return entries.map((entry) => ({
    path: entry.path.slice(root.length + 1),
    bytes: entry.bytes
  }));
};

export const readDeployArchive = async (request: Request): Promise<DeployArchive> => {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error("Deploy archive is empty.");
  }

  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(bytes);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid zip";
    throw new Error(`Unable to read deploy archive: ${reason}`);
  }

  const rawEntries = Object.entries(unzipped)
    .filter(([path]) => !path.replace(/\\/g, "/").endsWith("/"))
    .map(([path, entryBytes]) => ({
      path: normalizeArchivePath(path),
      bytes: entryBytes
    }))
    .filter((entry) => entry.path);

  const entries = stripCommonRoot(rawEntries).filter((entry) => entry.path);
  const files = new Map(entries.map((entry) => [entry.path, entry.bytes]));
  const uncompressedBytes = entries.reduce((total, entry) => total + entry.bytes.byteLength, 0);
  return {
    entries,
    files,
    compressedBytes: bytes.byteLength,
    uncompressedBytes
  };
};

export const readTextFile = (archive: DeployArchive, path: string) => {
  const bytes = archive.files.get(normalizeArchivePath(path));
  if (!bytes) return null;
  return textDecoder.decode(bytes);
};

export const archiveHasPrefix = (archive: DeployArchive, prefix: string) => {
  const normalizedPrefix = normalizeArchivePath(prefix).replace(/\/?$/, "/");
  return archive.entries.some((entry) => entry.path.startsWith(normalizedPrefix));
};
