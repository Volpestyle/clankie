import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type ViteUserConfig } from "vitest/config";
import { releaseOnlyTests } from "./scripts/testing/landing-test-policy.mjs";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));
const packagePath = relative(repoRoot, resolve(process.cwd())).replaceAll("\\", "/");
const packageTestPattern = /^(?:apps|integrations|packages)\/[^/]+$/u.test(packagePath)
  ? [`${packagePath}/test/**/*.test.ts`]
  : ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "integrations/*/test/**/*.test.ts"];

// These files run real batch installs, gates, Git pushes and revalidations.
// The local main-move proof alone starts 165 Git and eight pnpm processes;
// concurrent suite forks can consume its 30-second deadline under host load.
// Run both native queue proofs in the existing serial lane, with fork isolation.
const serialIntegrationTests = [
  "apps/clankie/test/integrate-remote.integration.test.ts",
  "apps/clankie/test/integrate.integration.test.ts",
];
const sharedTest = {
  setupFiles: [fileURLToPath(new URL("./scripts/testing/vitest-setup.ts", import.meta.url))],
  include: process.env.CLANKIE_RELEASE_RETRY_FILE
    ? [process.env.CLANKIE_RELEASE_RETRY_FILE]
    : packageTestPattern,
  exclude: [
    ...(process.env.CLANKIE_LANDING_TESTS === "1" ? releaseOnlyTests : []),
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
  // Each fork has its own fixture HOME and stores. CI's three-core macOS
  // runner also starts real service/SSH/process fixtures. Three forks reduce
  // contention without doubling the full suite's import and file-wait costs.
  fileParallelism: true,
  maxWorkers: process.env.CI ? 3 : 4,
  retry: 0,
  ...(process.env.CI
    ? {
        reporters: ["default", "junit"],
        outputFile: { junit: ".data/qa/tests.xml" },
      }
    : {}),
  ...(process.env.CLANKIE_RELEASE_TEST_REPORT
    ? {
        reporters: [
          "default",
          ...(process.env.CI ? ["junit"] : []),
          "./scripts/testing/release-test-reporter.mjs",
        ],
      }
    : {}),
  pool: "forks", // threads aborts on Node 26 worker isolate teardown; see ADR 0179
  testTimeout: 30_000,
  hookTimeout: 30_000,
} satisfies NonNullable<ViteUserConfig["test"]>;

export default defineConfig({
  root: repoRoot,
  test: {
    ...sharedTest,
    projects: [
      {
        test: {
          ...sharedTest,
          name: "parallel",
          exclude: [...sharedTest.exclude, ...serialIntegrationTests],
          sequence: { groupOrder: 0 },
        },
      },
      ...(sharedTest.include.some((pattern: string) =>
        ["apps/*/test/**/*.test.ts", "apps/clankie/test/**/*.test.ts", ...serialIntegrationTests].includes(
          pattern,
        ),
      )
        ? [
            {
              test: {
                ...sharedTest,
                name: "serial-integration",
                include: serialIntegrationTests,
                fileParallelism: false,
                maxWorkers: 1,
                sequence: { groupOrder: 1 },
              },
            },
          ]
        : []),
    ],
  },
});
