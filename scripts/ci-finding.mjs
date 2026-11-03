// Files a red background run on `main` or a schedule as `ci-finding` issues (ADR 0347).
// One issue per failing test, or per job when no test report names one. A repeat
// failure comments on the issue already open for it instead of filing another.
//
//   node scripts/ci-finding.mjs --job checkpoint [--report .local/checkpoint-run.json] [--dry-run]
//
// Needs GH_TOKEN with issues: write, GITHUB_REPOSITORY, and the run's URL in
// RUN_URL. --dry-run reads the open issues and prints what it would do.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const LABEL = "ci-finding";
/** More failures than this from one run are one finding, not a flood of issues. */
const MAX_FINDINGS = 10;

const { values } = parseArgs({
  options: {
    job: { type: "string" },
    report: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const job = values.job;
if (!job) throw new Error("--job is required");
const repo = process.env.GITHUB_REPOSITORY;
if (!repo) throw new Error("GITHUB_REPOSITORY is required");
const runUrl = process.env.RUN_URL ?? "(run URL unavailable)";
const dryRun = values["dry-run"];

/** Failing tests from the release test reporter's JSON, or nothing when it is absent or unreadable. */
function failures(path) {
  if (path === undefined || !existsSync(path)) return [];
  let report;
  try {
    report = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
  const found = [];
  for (const file of report.files ?? []) {
    if (file.state !== "failed") continue;
    const tests = (file.tests ?? []).filter((test) => test.state === "failed");
    if (tests.length === 0) found.push(file.path);
    for (const test of tests) found.push(`${file.path} › ${test.name}`);
  }
  for (const error of report.errors ?? []) found.push(`${job}: unhandled ${error.name}`);
  return found;
}

const tests = failures(values.report);
const keys =
  tests.length === 0
    ? [`${job} job`]
    : tests.length > MAX_FINDINGS
      ? [`${job}: ${String(tests.length)} failing tests`]
      : tests;
const detail = tests.length > MAX_FINDINGS ? tests.map((test) => `- ${test}`).join("\n") : "";

const gh = (args) => execFileSync("gh", args, { encoding: "utf8" });
const marker = (key) => `<!-- ci-finding ${createHash("sha256").update(key).digest("hex").slice(0, 16)} -->`;
// Oldest first, so a duplicate filed while GitHub's list lagged a create never takes the repeats.
const open = JSON.parse(
  gh([
    "issue",
    "list",
    "-R",
    repo,
    "--label",
    LABEL,
    "--state",
    "open",
    "--limit",
    "500",
    "--json",
    "number,body",
  ]),
).toSorted((a, b) => a.number - b.number);

for (const key of keys) {
  const tag = marker(key);
  const existing = open.find((issue) => issue.body.includes(tag));
  if (existing !== undefined) {
    const body = `Failed again: ${runUrl}`;
    if (dryRun) console.log(`would comment on #${String(existing.number)}: ${key}`);
    else console.log(gh(["issue", "comment", String(existing.number), "-R", repo, "--body", body]).trim());
    continue;
  }
  const title = `CI finding: ${key}`.slice(0, 250);
  const body = [
    `Failing on a background run: ${runUrl}`,
    "",
    `\`${key}\``,
    ...(detail ? ["", detail] : []),
    "",
    "Filed by `scripts/ci-finding.mjs` (ADR 0347). Rank it by how badly it blocks current goals; a repeat failure comments here.",
    "",
    tag,
  ].join("\n");
  if (dryRun) console.log(`would file: ${title}`);
  else
    console.log(
      gh(["issue", "create", "-R", repo, "--label", LABEL, "--title", title, "--body", body]).trim(),
    );
}
