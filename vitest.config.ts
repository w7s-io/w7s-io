import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": new URL("./src/__tests__/cloudflareWorkersShim.ts", import.meta.url).pathname
    }
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    restoreMocks: true
  }
});
