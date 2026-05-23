import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { readDeployArchive, readTextFile } from "../deploy/archive";

const zipRequest = (files: Record<string, string>) => {
  const zipped = zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, value]) => [path, new TextEncoder().encode(value)])
    )
  );
  return new Request("https://w7s.cloud/api/v1/deploy", {
    method: "POST",
    body: zipped
  });
};

describe("readDeployArchive", () => {
  it("normalizes common root folders", async () => {
    const archive = await readDeployArchive(
      zipRequest({
        "repo-main/worker/index.js": "export default {}",
        "repo-main/frontend/dist/index.html": "hello"
      })
    );

    expect(readTextFile(archive, "worker/index.js")).toBe("export default {}");
    expect(readTextFile(archive, "frontend/dist/index.html")).toBe("hello");
  });

  it("keeps static output roots when an archive only contains build artifacts", async () => {
    const archive = await readDeployArchive(
      zipRequest({
        "dist/index.html": "hello",
        "dist/assets/app.js": "console.log('ok')"
      })
    );

    expect(readTextFile(archive, "dist/index.html")).toBe("hello");
    expect(readTextFile(archive, "index.html")).toBeNull();
  });
});
