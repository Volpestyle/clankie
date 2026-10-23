import { spawn, execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// Release/manual only. A passing retry must be a complete, individually green
// default measurement; incomplete work and authority failures never get a retry.
const root = realpathSync(process.cwd());
const directory = join(root, ".data/qa");
mkdirSync(directory, { recursive: true });
for (const name of ["fleet-load.json", "fleet-load-attempt-1.json", "fleet-load-attempt-2.json"])
  rmSync(join(directory, name), { force: true });
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const head = git("rev-parse", "HEAD");
const budgets = {
  steadyCpuPercent: 9.9,
  healthP95Ms: 250,
  toolP95Ms: 2000,
  admissionRefusals: 0,
  linearCallsPerMinute: 24,
};
const attempts = [];
let exit = 1;

async function measure(output) {
  return await new Promise((fulfill) => {
    const child = spawn("pnpm", ["check:load", "--output", output], { cwd: root, stdio: "inherit" });
    let interrupted = false;
    const interrupt = (signal) => {
      interrupted = true;
      child.kill(signal);
    };
    const int = () => interrupt("SIGINT");
    const term = () => interrupt("SIGTERM");
    process.on("SIGINT", int);
    process.on("SIGTERM", term);
    child.on("error", (error) => console.error(error.message));
    child.on("close", (code, signal) => {
      process.off("SIGINT", int);
      process.off("SIGTERM", term);
      fulfill({ code, signal, interrupted });
    });
  });
}

function inspect(path, began, finished) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  const { metrics: m, workload: w } = report;
  if (
    report.schemaVersion !== 1 ||
    report.sourceCommit !== head ||
    realpathSync(report.sourceRoot) !== root ||
    !Number.isFinite(Date.parse(report.recordedAt)) ||
    Date.parse(report.recordedAt) < began ||
    Date.parse(report.recordedAt) > finished ||
    !["passed", "failed"].includes(report.outcome) ||
    !Array.isArray(report.errors) ||
    Object.entries(budgets).some(([name, value]) => report.budgets?.[name] !== value) ||
    w?.workers !== 10 ||
    w.durationSeconds !== 120 ||
    w.warmupSeconds !== 30 ||
    w.fleetFreshReadMs !== 1000 ||
    w.fleetLongPollMs !== 20000 ||
    w.workerToolMs !== 30000 ||
    w.workPanelMs !== 60000 ||
    w.warmup?.readyWorkers !== 10 ||
    ["workerToolCalls", "healthRequests", "fleetRequests", "elapsedSeconds"].some(
      (name) => !Number.isFinite(w.warmup[name]),
    ) ||
    w.warmup.workerToolCalls < 10 ||
    w.warmup.healthRequests < 1 ||
    w.warmup.fleetRequests < 1 ||
    w.warmup.elapsedSeconds < 30 ||
    !Array.isArray(report.samples) ||
    report.samples.length < 96 ||
    !m ||
    m.readyWorkers !== 10 ||
    m.elapsedSeconds < 120 ||
    [
      "steadyCpuPercent",
      "healthP95Ms",
      "toolP95Ms",
      "admissionRefusals",
      "linearCallsPerMinute",
      "elapsedSeconds",
      "healthRequests",
      "fleetRequests",
      "toolCalls",
    ].some((name) => !Number.isFinite(m[name]) || m[name] < 0) ||
    m.healthRequests < 96 ||
    m.fleetRequests < 96 ||
    m.toolCalls <= 0 ||
    m.admissionRefusals !== 0 ||
    m.toolP95Ms > budgets.toolP95Ms ||
    m.linearCallsPerMinute > budgets.linearCallsPerMinute
  )
    throw new Error("Incomplete, stale, changed-workload or non-timing failure; release load blocked.");
  const timingErrors = [
    ...(m.steadyCpuPercent > budgets.steadyCpuPercent
      ? [`steady CPU: ${m.steadyCpuPercent} exceeds budget ${budgets.steadyCpuPercent}`]
      : []),
    ...(m.healthP95Ms > budgets.healthP95Ms
      ? [`health p95: ${m.healthP95Ms} exceeds budget ${budgets.healthP95Ms}`]
      : []),
  ];
  if (
    report.errors.length !== timingErrors.length ||
    report.errors.some((error) => !timingErrors.includes(error)) ||
    report.outcome !== (timingErrors.length ? "failed" : "passed")
  )
    throw new Error(
      "Failure is not exclusively a measured health/CPU budget violation; release load blocked.",
    );
  return report;
}

try {
  for (let index = 1; index <= 2; index++) {
    if (git("rev-parse", "HEAD") !== head || git("status", "--porcelain", "--untracked-files=no"))
      throw new Error("Tracked source changed; release load blocked.");
    const output = join(directory, `fleet-load-attempt-${index}.json`);
    rmSync(output, { force: true });
    const began = Date.now();
    const result = await measure(output);
    const attempt = { index, output, ...result };
    attempts.push(attempt);
    if (git("rev-parse", "HEAD") !== head || git("status", "--porcelain", "--untracked-files=no"))
      throw new Error("Tracked source changed during measurement; release load blocked.");
    if (result.signal || result.interrupted || ![0, 1].includes(result.code))
      throw new Error("Load process failed or was interrupted; release load blocked.");
    const report = inspect(output, began, Date.now());
    attempt.metrics = report.metrics;
    attempt.errors = report.errors;
    copyFileSync(output, join(directory, "fleet-load.json"));
    if ((result.code === 0) !== (report.outcome === "passed"))
      throw new Error("Load exit and evidence disagree; release load blocked.");
    if (result.code === 0) {
      exit = 0;
      break;
    }
    if (index === 1)
      console.log("Release load: complete health/CPU-only failure; retrying once with unchanged budgets.");
  }
} catch (error) {
  console.error(error.message);
  attempts.push({ error: error.message });
}
const summary = [
  "## Release fleet load",
  "",
  ...attempts.map((attempt) =>
    attempt.error
      ? `Blocked: ${attempt.error}`
      : `- Attempt ${attempt.index}: exit ${attempt.code ?? attempt.signal}; health p95 ${attempt.metrics?.healthP95Ms ?? "unmeasured"} ms; CPU ${attempt.metrics?.steadyCpuPercent ?? "unmeasured"}%. ${attempt.errors?.join("; ") ?? ""}`,
  ),
  "",
  exit === 0
    ? attempts.length > 1
      ? "Passed on the one allowed retry; first failure retained."
      : "Passed on first attempt."
    : "Blocked: no complete passing measurement.",
  "",
].join("\n");
writeFileSync(
  join(directory, "fleet-load-release.json"),
  JSON.stringify({ head, exitCode: exit, attempts }, null, 2) + "\n",
);
writeFileSync(join(directory, "fleet-load-release-summary.md"), summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(summary);
process.exitCode = exit;
