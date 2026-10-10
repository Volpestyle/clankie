import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { landingTypechecks } from "./testing/landing-typechecks.mjs";
import {
  changePatchId,
  recordLandingHistory,
  revalidateLanding,
  sourceFingerprint,
} from "./testing/landing-validity.mjs";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
const revalidate = (separator < 0 ? args : args.slice(0, separator)).includes("--revalidate");
const options = (separator < 0 ? args : args.slice(0, separator)).filter((arg) => arg !== "--revalidate");
const vitestArgs = separator < 0 ? [] : args.slice(separator + 1);
for (let index = 0; index < options.length; index += 2)
  if (!["--root", "--base", "--report"].includes(options[index]))
    throw new Error(`Unknown gate option: ${options[index]}`);
for (const argument of vitestArgs)
  if (!/^--(?:reporter|outputFile)(?:\.[\w-]+)?=.+$/u.test(argument))
    throw new Error(`Only reporter/outputFile options may follow --: ${argument}`);
const value = (name, fallback) => {
  const index = options.indexOf(name);
  if (index < 0) return fallback;
  if (!options[index + 1] || options[index + 1].startsWith("--")) throw new Error(`Missing ${name} value`);
  return options[index + 1];
};
const root = resolve(value("--root", fileURLToPath(new URL("../", import.meta.url))));
process.chdir(root);
const git = (...command) => execFileSync("git", command, { cwd: root, encoding: "utf8" }).trim();
const explicitBase = value("--base", process.env.CLANKIE_LANDING_BASE);
// By default a gate checks the base HEAD actually sits on: origin/main is shared
// by every worktree and can move between a rebase and the gate starting.
// Revalidation then judges any newer origin/main (VUH-2024).
const base =
  explicitBase !== undefined || revalidate
    ? git("rev-parse", "--verify", `${explicitBase ?? "origin/main"}^{commit}`)
    : git("merge-base", "HEAD", "origin/main");
const head = git("rev-parse", "HEAD");
const reportPath = resolve(value("--report", ".local/landing-gate.json"));
if (revalidate) {
  // A moved base keeps a green gate only when nothing it checked changed (VUH-2024).
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    recorded = undefined;
  }
  const verdict = await revalidateLanding({ root, report: recorded, base });
  recordLandingHistory(root, {
    kind: "revalidate",
    head,
    base,
    gateHead: recorded?.head,
    gateBase: recorded?.base,
    patchId: recorded?.change?.patchId,
    valid: verdict.valid,
  });
  if (recorded) {
    (recorded.revalidations ??= []).push({ at: new Date().toISOString(), ...verdict });
    writeFileSync(reportPath, JSON.stringify(recorded, null, 2) + "\n");
  }
  console.log(JSON.stringify(verdict, null, 2));
  console.log(
    verdict.valid
      ? `[landing] gate for ${verdict.gate.head} still covers HEAD ${head} on base ${base}; push without rerunning`
      : "[landing] rerun the root gate: " + verdict.reasons.join("; "),
  );
  process.exit(verdict.valid ? 0 : 1);
}
const fingerprint = () => sourceFingerprint(root);
const source = await fingerprint();
const report = {
  head,
  base,
  source,
  // What this result covers, so a later base move can be judged without rerunning (VUH-2024).
  change: {
    rebased: spawnSync("git", ["merge-base", "--is-ancestor", base, head], { cwd: root }).status === 0,
    patchId: changePatchId(root, base, head),
    files: [
      ...new Set([
        ...git("diff", "--name-only", "-z", base).split("\0").filter(Boolean),
        ...git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean),
      ]),
    ].sort(),
  },
  phases: [],
  exitCode: null,
};
const save = () => {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
};
const started = performance.now();
let exit = 0;
const run = (name, command, environment = {}) => {
  if (exit) return;
  console.log(`[landing] ${name}: ${command.join(" ")}`);
  const before = performance.now();
  const child = spawnSync(command[0], command.slice(1), {
    stdio: "inherit",
    env: { ...process.env, CARGO_BUILD_JOBS: "1", ...environment },
  });
  const code = child.status ?? 1;
  if (child.error) console.error(child.error.message);
  report.phases.push({
    name,
    command,
    elapsedSeconds: (performance.now() - before) / 1000,
    exitCode: code,
    signal: child.signal,
  });
  exit = code;
  save();
};
console.log(`[landing] root ${root}; HEAD ${head}; fixed base ${base}`);
run("skills", ["pnpm", "herdr:skill:check"]);
run("format", ["pnpm", "fmt:check"]);
run("lint", ["pnpm", "lint"]);
run("deadcode", ["pnpm", "deadcode"]);
run("doc-links", ["node", "scripts/check-doc-links.mjs"]);
run("retired-claims", ["node", "scripts/check-retired-claims.mjs"]);
run("evidence", ["node", "scripts/testing/evidence-landing-guard.mjs"]);
if (!exit) {
  const before = performance.now();
  try {
    report.typecheckScope = landingTypechecks(root, base);
    report.typecheckScope.elapsedSeconds = (performance.now() - before) / 1000;
    console.log(
      `[landing] typecheck ${report.typecheckScope.packages.length}/${report.typecheckScope.total}: ${report.typecheckScope.packages.join(", ") || "no affected compiler inputs"}`,
    );
    if (report.typecheckScope.packages.length)
      run(
        "typecheck",
        [
          "pnpm",
          "exec",
          "turbo",
          "run",
          "typecheck",
          "--only",
          "--concurrency=1",
          ...report.typecheckScope.packages.map((name) => `--filter=${name}`),
        ],
        { CLANKIE_LANDING_TYPE_INPUTS: report.typecheckScope.inputHash },
      );
  } catch (error) {
    console.error(`[landing] Cannot determine compiler scope: ${error.message}`);
    report.typecheckScopeError = error.message;
    exit = 1;
  }
}
const graphPath = `${reportPath}.graph.json`;
rmSync(graphPath, { force: true });
run(
  "tests",
  [
    "pnpm",
    "exec",
    "vitest",
    "run",
    "--config",
    "vitest.config.ts",
    "--changed",
    base,
    "--bail",
    "1",
    "--passWithNoTests",
    ...(vitestArgs.some((argument) => argument.startsWith("--reporter")) ? [] : ["--reporter=default"]),
    "--reporter=./scripts/testing/landing-graph-reporter.mjs",
    ...vitestArgs,
  ],
  { CLANKIE_LANDING_GRAPH: graphPath },
);
if (!exit && existsSync(graphPath)) {
  report.tests = JSON.parse(readFileSync(graphPath, "utf8"));
  rmSync(graphPath, { force: true });
  // A changed manifest makes Vitest rerun every test, so the recorded graph
  // spans the repository. The tests this change can affect are the ones that
  // load a changed file or compile against it, plus any outside the compiler
  // graph (VUH-2044).
  const scope = report.typecheckScope;
  if (
    report.tests.modules &&
    scope?.reason === "real compiler import graph" &&
    report.change.files.some((path) => /(?:^|\/)package\.json$/u.test(path))
  ) {
    const changed = new Set(report.change.files);
    const relevant = new Set();
    for (const [module, dependencies] of Object.entries(report.tests.modules))
      if (!scope.owns(module) || dependencies.some((path) => changed.has(path) || scope.affects(path)))
        for (const path of dependencies) relevant.add(path);
    report.tests.relevantDependencies = [...relevant].sort();
  }
}
report.sourceStable = git("rev-parse", "HEAD") === head && (await fingerprint()) === source;
if (!report.sourceStable) {
  console.error("[landing] Source changed while the gate ran; this result cannot authorize a push.");
  exit = 1;
}
report.exitCode = exit;
report.elapsedSeconds = (performance.now() - started) / 1000;
save();
recordLandingHistory(root, { kind: "gate", head, base, patchId: report.change.patchId, exitCode: exit });
console.log(`[landing] exit ${exit}; ${report.elapsedSeconds.toFixed(2)}s; evidence ${reportPath}`);
process.exitCode = exit;
