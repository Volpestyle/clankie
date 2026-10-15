import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { retryFailedFiles } from "../../../scripts/check-release.mjs";

// VUH-2101 acceptance: real forked Vitest processes and real failure reports.
// No command/reporter mocks; scratch tests cannot enter the normal suite.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const reporter = join(repo, "scripts/testing/release-test-reporter.mjs");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(kinds: string[]) {
  const root = mkdtempSync(join(tmpdir(), "release-retry-"));
  roots.push(root);
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "package.json"), '{"type":"module"}\n');
  writeFileSync(
    join(root, "vitest.config.ts"),
    `
import { defineConfig } from 'vitest/config';
export default defineConfig({ root: ${JSON.stringify(root)}, test: {
  include: process.env.CLANKIE_RELEASE_RETRY_FILE ? [process.env.CLANKIE_RELEASE_RETRY_FILE] : ['apps/proof/test/*.test.ts'], pool: 'forks', retry: 0, maxWorkers: 1,
  reporters: ['default', ${JSON.stringify(reporter)}]
} });
`,
  );
  const paths = kinds.map((kind, index) => {
    const path =
      kind === "overlap"
        ? "apps/proof/test/0-flake.test.ts.extra.test.ts"
        : `apps/proof/test/${index}-${kind}.test.ts`;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      `
import { it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const marker = ${JSON.stringify(join(root, `${index}.count`))};
const count = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) + 1 : 1;
writeFileSync(marker, String(count));
it('unchanged passing case', () => expect(true).toBe(true));
${
  kind === "retry-hang"
    ? "it('hangs only on rerun', () => count > 1 ? new Promise(() => {}) : expect(false).toBe(true), 60_000);"
    : kind === "hang"
      ? "it('real hang', () => new Promise(() => {}), 100);"
      : kind === "unhandled"
        ? "it('unhandled rejection', async () => { Promise.reject(new Error('outside test assertion')); await new Promise(r => setTimeout(r, 10)); });"
        : kind === "skip"
          ? "it.skipIf(count > 1)('first failed case', () => expect(false).toBe(true));"
          : `it('first failed case', () => expect(${["green", "overlap"].includes(kind) ? "true" : kind === "persistent" ? "false" : "count > 1"}).toBe(true));`
}
`,
    );
    return path;
  });
  mkdirSync(join(root, ".data/qa"), { recursive: true });
  const runId = randomUUID();
  const firstReport = join(root, ".data/qa/first.json");
  const first = spawnSync("pnpm", ["exec", "vitest", "run", "--config", "vitest.config.ts"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      VITEST_MAX_WORKERS: "1",
      CLANKIE_RELEASE_TEST_REPORT: firstReport,
      CLANKIE_RELEASE_TEST_RUN_ID: runId,
    },
  });
  expect(first.error, first.stderr).toBeUndefined();
  expect(existsSync(firstReport), first.stdout + first.stderr).toBe(true);
  const counts = () => kinds.map((_, index) => Number(readFileSync(join(root, `${index}.count`), "utf8")));
  const summary = () => readFileSync(join(root, ".data/qa/release-check-summary.md"), "utf8");
  return { root, firstReport, runId, first, paths, counts, summary, summaryFile: "" };
}

it("reruns only each failed file once and accepts two recovered files", async () => {
  const proof = fixture(["flake", "overlap", "flake"]);
  expect(proof.first.status).toBe(1);
  expect(await retryFailedFiles(proof)).toBe(true);
  expect(proof.counts()).toEqual([2, 1, 2]);
  expect(proof.summary()).toContain("Flaky on first attempt");
  expect(proof.summary()).toContain(proof.paths[0]);
  expect(proof.summary()).toContain(proof.paths[2]);
  expect(proof.summary()).not.toContain(proof.paths[1]);
});

it("still reruns every file but blocks more than two recovered flakes", async () => {
  const proof = fixture(["flake", "flake", "flake"]);
  expect(await retryFailedFiles(proof)).toBe(false);
  expect(proof.counts()).toEqual([2, 2, 2]);
  for (const path of proof.paths) expect(proof.summary()).toContain(path);
});

it("persistent failures and real timed-out tests block without skipping later files", async () => {
  const proof = fixture(["persistent", "hang", "flake"]);
  expect(await retryFailedFiles(proof)).toBe(false);
  expect(proof.counts()).toEqual([2, 2, 2]);
  expect(proof.summary()).toContain("Failed isolated reruns");
  for (const path of proof.paths) expect(proof.summary()).toContain(path);
});

it("a previously failed case becoming skipped cannot recover a file", async () => {
  const proof = fixture(["skip"]);
  expect(await retryFailedFiles(proof)).toBe(false);
  expect(proof.counts()).toEqual([2]);
});

it("unhandled errors, incomplete reports and stale reports cannot trigger recovery", async () => {
  const unhandled = fixture(["unhandled"]);
  expect(unhandled.first.status).toBe(1);
  expect(await retryFailedFiles(unhandled)).toBe(false);
  expect(unhandled.counts()).toEqual([1]);
  const proof = fixture(["flake"]);
  expect(await retryFailedFiles({ ...proof, runId: randomUUID() })).toBe(false);
  const report = JSON.parse(readFileSync(proof.firstReport, "utf8"));
  report.files = [];
  writeFileSync(proof.firstReport, JSON.stringify(report));
  expect(await retryFailedFiles(proof)).toBe(false);
  rmSync(proof.firstReport);
  expect(await retryFailedFiles(proof)).toBe(false);
  expect(proof.counts()).toEqual([1]);
});

// VUH-2291: exercise the real runner deadline, not Vitest's per-test timeout.
it("bounds the entire retry pass and stops before retrying any later failed file", async () => {
  const proof = fixture(["retry-hang", "flake"]);
  const receipts: { passed: boolean; signal: string }[] = [];
  const started = performance.now();
  expect(
    await retryFailedFiles({ ...proof, retryTimeoutMs: 3_000, onRetry: (receipt) => receipts.push(receipt) }),
  ).toBe(false);
  expect(performance.now() - started).toBeLessThan(10_000);
  expect(proof.counts()).toEqual([2, 1]);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ passed: false, signal: "SIGKILL" });
  expect(proof.summary()).toContain("exceeded 3000ms");
});
