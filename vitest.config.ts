import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every fixture repository lives below one run-scoped root. The teardown in
    // global-temp removes it after the last worker, so hundreds of flow fixtures
    // do not become hundreds of permanent /tmp directories.
    globalSetup: ["./test/global-temp.ts"],
  },
});
