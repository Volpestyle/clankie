// Files a red background run on `main` or a schedule as `ci-finding` issues (ADR 0347).
// One issue per failing test, or per job when no test report names one. A repeat
// failure comments on the issue already open for it instead of filing another.
//
//   node scripts/ci-finding.mjs --job checkpoint [--report .local/checkpoint-run.json] [--dry-run]
//   node scripts/ci-finding.mjs --after mac,real-run [--run ID --attempt N] [--dry-run]
//
// `--after` runs from a job that always checks out, after self-hosted jobs whose own
// finding step may never have run: a job that died before checkout (as at "Set up
// runner") has no script on disk (#551). It reads this run's jobs and files for each
// named job that failed without its own finding step succeeding: one finding per
// runner whose setup failed, otherwise the job's. The run is GITHUB_RUN_ID and
// GITHUB_RUN_ATTEMPT unless --run and --attempt name another.
//
// Needs GH_TOKEN with issues: write (and actions: read for --after), GITHUB_REPOSITORY,
// and the run's URL in RUN_URL. --dry-run reads the open issues and prints what it would do.
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
    after: { type: "string" },
    run: { type: "string" },
    attempt: { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});
const job = values.job;
if (!job === !values.after) throw new Error("Pass exactly one of --job and --after");
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

const gh = (args) => execFileSync("gh", args, { encoding: "utf8" });

/** The named jobs of this run that failed and couldn't file their own finding (#551). */
function unfiled(names) {
  const run = values.run ?? process.env.GITHUB_RUN_ID;
  const attempt = values.attempt ?? process.env.GITHUB_RUN_ATTEMPT ?? "1";
  if (!run) throw new Error("--after needs GITHUB_RUN_ID or --run");
  const jobs = JSON.parse(
    gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repo}/actions/runs/${run}/attempts/${attempt}/jobs?per_page=100`,
    ]),
  ).flatMap((page) => page.jobs ?? []);
  const found = new Map();
  for (const entry of jobs) {
    if (!names.includes(entry.name) || entry.conclusion !== "failure") continue;
    const steps = entry.steps ?? [];
    if (steps.some((step) => step.name === "File a ci-finding" && step.conclusion === "success")) continue;
    const setup = steps.some((step) => step.name === "Set up runner" && step.conclusion === "failure");
    // A broken runner is one finding however many jobs it fails; anything else is the job's.
    const key = setup
      ? `runner setup failed on ${entry.runner_name ?? "an unnamed runner"}`
      : `${entry.name} job`;
    const line = `- ${entry.name}${setup ? " died at Set up runner, before checkout" : " failed and its finding step did not run"}: ${entry.html_url ?? runUrl}`;
    found.set(key, [...(found.get(key) ?? []), line]);
  }
  return found;
}

let keys;
let details = new Map();
if (values.after) {
  details = unfiled(
    values.after
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  keys = [...details.keys()];
  if (keys.length === 0) console.log("Every failed job filed its own finding; nothing to file.");
} else {
  const tests = failures(values.report);
  keys =
    tests.length === 0
      ? [`${job} job`]
      : tests.length > MAX_FINDINGS
        ? [`${job}: ${String(tests.length)} failing tests`]
        : tests;
  if (tests.length > MAX_FINDINGS)
    details.set(
      keys[0],
      tests.map((test) => `- ${test}`),
    );
}
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
  const detail = (details.get(key) ?? []).join("\n");
  if (existing !== undefined) {
    const body = [`Failed again: ${runUrl}`, ...(detail ? ["", detail] : [])].join("\n");
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
