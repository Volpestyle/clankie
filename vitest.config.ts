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
    include: packageTestPattern,
    exclude: ["**/node_modules/**", "**/.turbo/**", "**/dist/**", "artifacts/**"],
    fileParallelism: false,
    maxWorkers: 1,
    pool: "threads",
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
