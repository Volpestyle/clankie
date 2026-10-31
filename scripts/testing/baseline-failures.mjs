// Tells a change's own test failures from ones its base already has (ADR 0310).
//
//   node scripts/testing/baseline-failures.mjs --base <commit> --report <vitest-json>
//
// Reads the failed tests from a Vitest JSON report of the change, runs those
// same test files on the base commit in a scratch worktree, and exits 0 only
// when every failure also fails there. A failure the base does not have, a test
// file the base does not have, or a report it cannot read exits 1, so a change
// still fails on anything it newly breaks. Failures the base shares are printed
// as warnings: they belong to main, and the lead files and fixes them there.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing ${name}`);
  return args[index + 1];
};
const git = (...command) => execFileSync("git", command, { cwd: root, encoding: "utf8" }).trim();
const base = git("rev-parse", "--verify", `${value("--base")}^{commit}`);
const reportPath = resolve(value("--report"));

/** Failed tests in a Vitest JSON report, as `file > full name`, plus files that failed outside a test. */
const failures = (path, from) => {
  const report = JSON.parse(readFileSync(path, "utf8"));
  const failed = new Set();
  for (const file of report.testResults ?? []) {
    const name = relative(from, file.name).replaceAll("\\", "/");
    const tests = (file.assertionResults ?? []).filter((test) => test.status === "failed");
    for (const test of tests) failed.add(`${name} > ${test.fullName}`);
    // A suite that failed to load or failed in a hook has no failed test to name.
    if (file.status === "failed" && !tests.length) failed.add(`${name} > (file)`);
  }
  return failed;
};

const changeFailed = failures(reportPath, root);
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
  const tree = join(root, ".local", `baseline-${base.slice(0, 12)}`);
  rmSync(tree, { recursive: true, force: true });
  spawnSync("git", ["worktree", "prune"], { cwd: root });
  execFileSync("git", ["worktree", "add", "--detach", tree, base], { cwd: root, stdio: "inherit" });
  try {
    const install = spawnSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
      cwd: tree,
      stdio: "inherit",
    });
    if (install.status !== 0) throw new Error(`pnpm install on the base exited ${install.status}`);
    const output = join(tree, ".local", "baseline-tests.json");
    // Same runner, same environment, same selected files: only the commit differs.
    spawnSync(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--config",
        "vitest.config.ts",
        ...present,
        "--bail",
        "0",
        "--passWithNoTests",
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${output}`,
      ],
      { cwd: tree, stdio: "inherit", env: { ...process.env, CLANKIE_LANDING_TESTS: "1" } },
    );
    if (!existsSync(output)) throw new Error("The base run wrote no report");
    baseline = failures(output, tree);
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: root, stdio: "inherit" });
  }
}

const shared = [...changeFailed].filter((key) => baseline.has(key)).sort();
const own = [...changeFailed].filter((key) => !baseline.has(key)).sort();
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
