import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const goldens = join(import.meta.dirname, "fixtures/release-load");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Replay actual CI load evidence through real pnpm/Node child processes. The
// replay changes the source/time envelope, not the observed metric values.
function replay(cases: string[]) {
  const root = mkdtempSync(join(tmpdir(), "release-load-"));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ private: true, scripts: { "check:load": "node replay.mjs" } }),
  );
  writeFileSync(
    join(root, "replay.mjs"),
    `
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const cases = ${JSON.stringify(cases)};
const count = existsSync('count') ? Number(readFileSync('count', 'utf8')) : 0;
writeFileSync('count', String(count + 1));
const kind = cases[count] ?? 'cpu-failed';
if (kind === 'process-error') process.exit(2);
if (kind === 'interrupted') process.kill(process.pid, 'SIGTERM');
if (kind === 'missing') process.exit(1);
const source = ['passed', 'cpu-failed', 'health-failed'].includes(kind) ? kind : 'health-failed';
const report = JSON.parse(readFileSync(${JSON.stringify(goldens)} + '/' + source + '.json', 'utf8'));
report.sourceRoot = process.cwd();
report.sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
report.recordedAt = new Date().toISOString();
report.workload.warmupSeconds = 30;
// This is the current envelope, not a claim about the old idle warm-up.
report.workload.warmup = { readyWorkers: 10, workerToolCalls: 10, healthRequests: 30, fleetRequests: 30, elapsedSeconds: 30 };
if (kind === 'cold') report.workload.warmup.readyWorkers = 9;
if (kind === 'stale') report.recordedAt = '2000-01-01T00:00:00.000Z';
if (kind === 'incomplete') report.metrics.elapsedSeconds = 119;
if (kind === 'weakened') report.budgets.healthP95Ms = 2500;
if (kind === 'admission') { report.metrics.admissionRefusals = 1; report.errors.push('admission refusals: 1 exceeds budget 0'); }
if (kind === 'other-error') report.errors.push('Legitimate tool call failed');
if (kind === 'changed') writeFileSync('package.json', readFileSync('package.json', 'utf8') + ' ');
writeFileSync(process.argv.at(-1), JSON.stringify(report));
process.exit(kind === 'disagrees' ? 0 : report.outcome === 'passed' ? 0 : 1);
`,
  );
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "package.json", "replay.mjs"], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "replay load reports",
    ],
    { cwd: root },
  );
  const child = spawnSync(process.execPath, [join(repo, "scripts/check-release-load.mjs")], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, GITHUB_STEP_SUMMARY: join(root, "summary.md") },
  });
  expect(child.error, child.stdout + child.stderr).toBeUndefined();
  const report = JSON.parse(readFileSync(join(root, ".data/qa/fleet-load-release.json"), "utf8"));
  return {
    root,
    child,
    report,
    count: Number(readFileSync(join(root, "count"), "utf8")),
    summary: readFileSync(join(root, "summary.md"), "utf8"),
  };
}

it("keeps a first-pass success to one real child invocation", () => {
  const proof = replay(["passed"]);
  expect(proof.child.status).toBe(0);
  expect(proof.count).toBe(1);
  expect(proof.summary).toContain("Passed on first attempt");
});

it.each(["health-failed", "cpu-failed"])(
  "retains a real %s report and accepts exactly one complete passing retry",
  (failure) => {
    const proof = replay([failure, "passed"]);
    expect(proof.child.status).toBe(0);
    expect(proof.count).toBe(2);
    expect(proof.summary).toContain("first failure retained");
    expect(proof.report.attempts[0].errors).not.toEqual([]);
    expect(proof.report.attempts[1].errors).toEqual([]);
    const first = JSON.parse(readFileSync(join(proof.root, ".data/qa/fleet-load-attempt-1.json"), "utf8"));
    const original = JSON.parse(readFileSync(join(goldens, failure + ".json"), "utf8"));
    expect(first.metrics).toEqual(original.metrics);
    expect(first.budgets).toEqual(original.budgets);
  },
);

it("blocks a persistent measured violation after two attempts without consuming a third green report", () => {
  const proof = replay(["health-failed", "cpu-failed", "passed"]);
  expect(proof.child.status).toBe(1);
  expect(proof.count).toBe(2);
  expect(proof.report.exitCode).toBe(1);
  expect(proof.summary).toContain("Blocked: no complete passing measurement");
});

it.each([
  "cold",
  "admission",
  "other-error",
  "incomplete",
  "stale",
  "weakened",
  "missing",
  "process-error",
  "interrupted",
  "disagrees",
  "changed",
])("never recovers %s by consuming a later passing report", (failure) => {
  const proof = replay([failure, "passed"]);
  expect(proof.child.status).toBe(1);
  expect(proof.count).toBe(1);
  expect(proof.summary).toContain("Blocked");
});
