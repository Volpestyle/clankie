// Tells a change's own test failures from ones its base already has (ADR 0310).
//
//   node scripts/testing/baseline-failures.mjs --base <commit> --report <run-report>
//
// The report is the one scripts/testing/release-test-reporter.mjs writes. It
// must be complete: a run that was interrupted, left a selected file unfinished
// or raised an unhandled error exits 1 before any comparison, the same report
// rule check-release.mjs holds releases to. Reads the failed tests, runs those
// same test files on the base commit in a scratch worktree, and exits 0 only
// when every failure also fails there. A failure the base does not have, a test
// file the base does not have, or a report it cannot read exits 1, so a change
// still fails on anything it newly breaks. So does a file that failed outside
// any test (a load error or a failed hook, even beside failed tests): such an
// error has no test name to match, so it is never matched with the base. Failures the base shares are printed
// as warnings: they belong to main, and the lead files and fixes them there.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`);
  return args[index + 1];
};
const git = (...command) => execFileSync("git", command, { cwd: root, encoding: "utf8" }).trim();
const verifyOnly = args.includes("--verify-only");
const generic = args.includes("--generic");
const base = verifyOnly ? undefined : git("rev-parse", "--verify", `${value("--base")}^{commit}`);
const reportPath = resolve(value("--report"));

const FILE_FAILURE = "> (failed outside a test)";
const reporter = args.includes("--reporter")
  ? resolve(root, value("--reporter"))
  : join(root, "scripts", "testing", "release-test-reporter.mjs");
const config = args.includes("--config") ? value("--config") : "vitest.config.ts";

/** Failed tests in a complete run report, as `file > full name`, plus files that failed outside a test. */
const failures = (path) => {
  const report = JSON.parse(readFileSync(path, "utf8"));
  const finished = new Set((report.files ?? []).map((file) => file.path));
  if (
    report.version !== 1 ||
    !["passed", "failed"].includes(report.reason) ||
    !Array.isArray(report.errors) ||
    report.errors.length ||
    !Array.isArray(report.selected) ||
    !Array.isArray(report.files) ||
    report.selected.some((file) => !finished.has(file))
  ) {
    for (const error of report.errors ?? []) console.error(`[baseline] ${error.name}: ${error.message}`);
    throw new Error(
      `${path} is an interrupted, incomplete or unhandled-error run, so its failures are not only test results.`,
    );
  }
  const failed = new Set();
  for (const file of report.files) {
    if (!["passed", "failed", "skipped"].includes(file.state))
      throw new Error(`${file.path} did not finish (${file.state}).`);
    const tests = (file.tests ?? []).filter((test) => test.state === "failed");
    for (const test of tests) failed.add(`${file.path} > ${test.name}`);
    // A load error or a failed hook belongs to no test, even beside failed tests.
    if (file.state === "failed" && (!tests.length || file.suiteErrors !== 0))
      failed.add(`${file.path} ${FILE_FAILURE}`);
  }
  return failed;
};

let changeFailed;
try {
  changeFailed = failures(reportPath);
} catch (error) {
  console.error(`[baseline] ${error.message}`);
  process.exit(1);
}
// A generic starter cannot call an empty or ambiguous selection a checked suite.
const completeSelection = (path) => {
  const report = JSON.parse(readFileSync(path, "utf8"));
  if (
    !report.selected.length ||
    new Set(report.selected).size !== report.selected.length ||
    report.files.length !== report.selected.length ||
    new Set(report.files.map((file) => file.path)).size !== report.files.length ||
    !report.files.some((file) => file.tests.some((test) => ["passed", "failed"].includes(test.state)))
  )
    throw new Error("Empty, duplicate-file or unexecuted test selection cannot prove the starter gate");
};
if (generic || verifyOnly) completeSelection(reportPath);
// The starter verifies a fresh completed report even when the test step succeeds.
if (args.includes("--status")) {
  const status = value("--status");
  const reason = JSON.parse(readFileSync(reportPath, "utf8")).reason;
  if (
    !(
      (status === "success" && reason === "passed" && changeFailed.size === 0) ||
      (status === "failure" && reason === "failed" && changeFailed.size > 0)
    )
  )
    throw new Error("The test step outcome and completed report disagree");
}
if (args.includes("--exit-code")) {
  const code = value("--exit-code");
  const reason = JSON.parse(readFileSync(reportPath, "utf8")).reason;
  if (
    !(
      (code === "0" && reason === "passed" && changeFailed.size === 0) ||
      (code === "1" && reason === "failed" && changeFailed.size > 0)
    )
  )
    throw new Error("The test process exit code and completed report disagree");
}
if (verifyOnly) process.exit(changeFailed.size ? 1 : 0);
if (generic && !changeFailed.size) process.exit(0);
if (!changeFailed.size) {
  console.error("[baseline] The report shows no failed test, so the failure was not a test result.");
  process.exit(1);
}
const files = [...new Set([...changeFailed].map((key) => key.split(" > ")[0]))].sort();
const missing = files.filter(
  (file) => spawnSync("git", ["cat-file", "-e", `${base}:${file}`], { cwd: root }).status !== 0,
);
const present = files.filter((file) => !missing.includes(file));
console.log(
  `[baseline] ${changeFailed.size} failed test(s) in ${files.length} file(s); rerunning on ${base}`,
);

let baseline = new Set();
if (present.length) {
  mkdirSync(join(root, ".local"), { recursive: true });
  const tree = generic
    ? mkdtempSync(join(root, ".local", "fast-ci-base-"))
    : join(root, ".local", `baseline-${base.slice(0, 12)}`);
  if (!generic) {
    rmSync(tree, { recursive: true, force: true });
    spawnSync("git", ["worktree", "prune"], { cwd: root });
  }
  execFileSync("git", ["worktree", "add", "--detach", tree, base], { cwd: root, stdio: "inherit" });
  try {
    const install = spawnSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
      cwd: tree,
      stdio: "inherit",
    });
    if (install.status !== 0) throw new Error(`pnpm install on the base exited ${install.status}`);
    const output = join(tree, ".local", "baseline-run.json");
    mkdirSync(join(tree, ".local"), { recursive: true });
    // Same runner, same environment, same selected files: only the commit differs.
    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        config,
        ...present,
        "--bail",
        "0",
        "--passWithNoTests",
        "--reporter=default",
        `--reporter=${reporter}`,
      ],
      {
        cwd: tree,
        stdio: "inherit",
        env: {
          ...process.env,
          ...(generic ? {} : { CLANKIE_LANDING_TESTS: "1" }),
          CLANKIE_RELEASE_TEST_REPORT: output,
        },
      },
    );
    if (!existsSync(output)) throw new Error("The base run wrote no report");
    baseline = failures(output);
    if (generic) {
      completeSelection(output);
      const reason = JSON.parse(readFileSync(output, "utf8")).reason;
      if (
        result.error ||
        result.signal ||
        !(
          (result.status === 0 && reason === "passed" && !baseline.size) ||
          (result.status === 1 && reason === "failed" && baseline.size > 0)
        )
      )
        throw new Error("The base test process and completed report disagree");
    }
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: root, stdio: "inherit" });
  }
}

// Two different errors outside a test look the same here, so such a failure stays this change's.
const matches = (key) => baseline.has(key) && !key.endsWith(FILE_FAILURE);
const shared = [...changeFailed].filter(matches).sort();
const own = [...changeFailed].filter((key) => !matches(key)).sort();
const summary = [
  "### Test failures compared with the base",
  "",
  `Base \`${base.slice(0, 12)}\`: ${shared.length} already failing there, ${own.length} new in this change.`,
  "",
  ...shared.map((key) => `- already failing on the base: ${key}`),
  ...own.map((key) => `- **new**: ${key}`),
  "",
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
for (const key of shared)
  console.log(`::warning title=Already failing on main::${key} fails on the base too; fix it on main.`);
for (const key of own)
  console.log(
    `::error title=New test failure::${key}${missing.includes(key.split(" > ")[0]) ? " (new file)" : ""}`,
  );
console.log(summary);
process.exit(own.length ? 1 : 0);
