import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const packagePath = relative(repoRoot, resolve(process.cwd())).replaceAll("\\", "/");
const packageTestPattern = /^(?:apps|integrations|packages)\/[^/]+$/u.test(packagePath)
  ? [`${packagePath}/test/**/*.test.ts`]
  : ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "integrations/*/test/**/*.test.ts"];

export default defineConfig({
  root: repoRoot,
  test: {
    setupFiles: [fileURLToPath(new URL("./scripts/testing/vitest-setup.ts", import.meta.url))],
    include: packageTestPattern,
    exclude: [
      ...(process.env.CLANKIE_COMPUTER_INTEGRATION === "1"
        ? []
        : [
            "apps/clankie/test/computer-body.integration.test.ts",
            "apps/clankie/test/computer-windows.integration.test.ts",
          ]),
      "**/node_modules/**",
      "**/.turbo/**",
      "**/dist/**",
      "artifacts/**",
      "packages/play/test/free-play-corpus.test.ts", // Explicit manual eval lane.
    ],
    // Each fork has its own fixture HOME and stores. Bound concurrency inside
    // the fleet heavy permit instead of paying every file's import/wait serially.
    fileParallelism: true,
    maxWorkers: 4,
    retry: 0,
    ...(process.env.CI
      ? {
          reporters: ["default", "junit"],
          outputFile: { junit: ".data/qa/tests.xml" },
        }
      : {}),
    pool: "forks", // threads aborts on Node 26 worker isolate teardown; see ADR 0179
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
