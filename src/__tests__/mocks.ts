import type { Env } from "../env";

export class MemoryKV {
  private readonly values = new Map<string, string>();

  async get(key: string, type?: "text" | "json" | "arrayBuffer" | "stream") {
    const value = this.values.get(key) ?? null;
    if (value === null) return null;
    if (type === "json") return JSON.parse(value);
    if (type === "arrayBuffer") return new TextEncoder().encode(value).buffer;
    if (type === "stream") return new Response(value).body;
    return value;
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, _options?: KVNamespacePutOptions) {
    if (typeof value === "string") {
      this.values.set(key, value);
      return;
    }
    if (value instanceof ReadableStream) {
      this.values.set(key, await new Response(value).text());
      return;
    }
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer);
    this.values.set(key, new TextDecoder().decode(bytes));
  }

  async delete(key: string) {
    this.values.delete(key);
  }

  async list(options?: { prefix?: string }) {
    const prefix = options?.prefix ?? "";
    return {
      keys: [...this.values.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: ""
    };
  }

  async getWithMetadata(key: string, type?: "text" | "json" | "arrayBuffer" | "stream") {
    return {
      value: await this.get(key, type),
      metadata: null,
      cacheStatus: null
    };
  }
}

class MemoryR2Object {
  private readonly bytesValue: Uint8Array;
  readonly body: ReadableStream;
  readonly bodyUsed = false;
  readonly key: string;
  readonly version = "";
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly uploaded = new Date();
  readonly checksums = { toJSON: () => ({}) };
  readonly httpMetadata: R2HTTPMetadata;
  readonly customMetadata: Record<string, string>;
  readonly range: R2Range | undefined = undefined;
  readonly storageClass = "Standard";

  constructor(key: string, bytes: Uint8Array, httpMetadata: R2HTTPMetadata, customMetadata: Record<string, string>) {
    this.bytesValue = bytes;
    this.key = key;
    this.size = bytes.byteLength;
    this.etag = customMetadata.sha256 ?? "etag";
    this.httpEtag = `"${this.etag}"`;
    this.httpMetadata = httpMetadata;
    this.customMetadata = customMetadata;
    this.body = new Response(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    ).body as ReadableStream;
  }

  writeHttpMetadata(headers: Headers) {
    if (this.httpMetadata.contentType) headers.set("content-type", this.httpMetadata.contentType);
  }

  async arrayBuffer() {
    return this.bytesValue.buffer.slice(
      this.bytesValue.byteOffset,
      this.bytesValue.byteOffset + this.bytesValue.byteLength
    ) as ArrayBuffer;
  }

  async text() {
    return new TextDecoder().decode(this.bytesValue);
  }

  async json<T>() {
    return JSON.parse(await this.text()) as T;
  }

  async blob() {
    return new Blob([
      this.bytesValue.buffer.slice(
        this.bytesValue.byteOffset,
        this.bytesValue.byteOffset + this.bytesValue.byteLength
      ) as ArrayBuffer
    ]);
  }
}

export class MemoryR2 {
  private readonly values = new Map<string, MemoryR2Object>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async put(key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null, options?: R2PutOptions) {
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof ReadableStream
          ? new Uint8Array(await new Response(value).arrayBuffer())
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : value
              ? new Uint8Array(value.buffer)
              : new Uint8Array();
    const httpMetadata =
      options?.httpMetadata instanceof Headers ? {} : options?.httpMetadata ?? {};
    const object = new MemoryR2Object(
      key,
      bytes,
      httpMetadata,
      options?.customMetadata ?? {}
    );
    this.values.set(key, object);
    return object;
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }

  async head(key: string) {
    return this.values.get(key) ?? null;
  }

  async list() {
    return {
      objects: [...this.values.values()],
      truncated: false,
      delimitedPrefixes: []
    };
  }

  createMultipartUpload(): Promise<R2MultipartUpload> {
    throw new Error("Not implemented.");
  }

  resumeMultipartUpload(): R2MultipartUpload {
    throw new Error("Not implemented.");
  }
}

export class MemoryAnalyticsEngine {
  readonly points: AnalyticsEngineDataPoint[] = [];

  writeDataPoint(point?: AnalyticsEngineDataPoint) {
    if (point) this.points.push(point);
  }
}

export const createTestEnv = (overrides: Partial<Env> = {}): Env => ({
  DEPLOYMENTS_KV: new MemoryKV() as unknown as KVNamespace,
  STATIC_ASSETS: new MemoryR2() as unknown as R2Bucket,
  W7S_BASE_DOMAIN: "w7s.cloud",
  ...overrides
});
