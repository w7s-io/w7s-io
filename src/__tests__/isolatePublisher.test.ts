import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { readDeployArchive } from "../deploy/archive";
import { buildIsolateUploadModules, detectWorkerEntrypoint } from "../deploy/isolatePublisher";
import { buildStableScriptName } from "../names";

const archiveFromFiles = async (files: Record<string, string>) => {
  const zipped = zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, value]) => [path, new TextEncoder().encode(value)])
    )
  );
  return readDeployArchive(
    new Request("https://w7s.cloud/api/v1/deploy", {
      method: "POST",
      body: zipped
    })
  );
};

describe("isolate publishing helpers", () => {
  it("detects entrypoints and uploads relative modules", async () => {
    const archive = await archiveFromFiles({
      "worker/index.ts": "import { ok } from './lib.ts'; export default { fetch(){ return new Response(String(ok)) } }",
      "worker/lib.ts": "export const ok: boolean = true;"
    });

    const entrypoint = detectWorkerEntrypoint(archive);
    expect(entrypoint).toBe("worker/index.ts");
    const modules = buildIsolateUploadModules(entrypoint!, archive);
    expect(modules.map((module) => module.name).sort()).toEqual(["index.ts", "lib.ts"]);
    expect(modules.find((module) => module.name === "lib.ts")?.content).toContain("export const ok = true");
  });

  it("supports backend/ as a native app root", async () => {
    const archive = await archiveFromFiles({
      "backend/index.ts": "import { message } from './message.ts'; export default { fetch(){ return new Response(message) } }",
      "backend/message.ts": "export const message: string = 'hello backend';"
    });

    const entrypoint = detectWorkerEntrypoint(archive);
    expect(entrypoint).toBe("backend/index.ts");
    const modules = buildIsolateUploadModules(entrypoint!, archive);
    expect(modules.map((module) => module.name).sort()).toEqual(["index.ts", "message.ts"]);
  });

  it("supports Cloudflare build output under dist/server", async () => {
    const archive = await archiveFromFiles({
      "dist/server/index.js": "import { worker } from './assets/worker-entry.js'; import 'node:events'; export default worker;",
      "dist/server/assets/worker-entry.js": "export const worker = { fetch(){ return new Response('ssr') } };"
    });

    const entrypoint = detectWorkerEntrypoint(archive);
    expect(entrypoint).toBe("dist/server/index.js");
    const modules = buildIsolateUploadModules(entrypoint!, archive);
    expect(modules.map((module) => module.name).sort()).toEqual([
      "assets/worker-entry.js",
      "index.js"
    ]);
  });

  it("builds stable script names", () => {
    expect(buildStableScriptName("W7S-IO", "Demo_App", "production")).toBe("w7s-io--demo-app--production");
  });
});
