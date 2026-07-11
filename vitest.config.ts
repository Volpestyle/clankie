import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.turbo/**", "**/dist/**", "artifacts/**"],
    fileParallelism: false,
    maxWorkers: 1,
    pool: "threads",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
