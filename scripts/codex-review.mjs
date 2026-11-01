#!/usr/bin/env node
// Local Codex review (ADR 0323). A Codex worker on the owner's Mac reviews a
// pull request in its own read-only checkout, then this script posts every
// finding as one GitHub review headed "Codex review" under the Mac's `gh`
// login and sets the `codex-clean` commit status on that exact head commit.
// `land` merges only when `codex-clean` passed on the current head and every
// other check on it finished green, so a new push always waits for a new
// review. No dependencies: Node 22+, git and an authenticated `gh`.
//
//   node scripts/codex-review.mjs prepare OWNER/REPO PR
//   node scripts/codex-review.mjs post    OWNER/REPO PR --head SHA --findings FILE
//   node scripts/codex-review.mjs status  OWNER/REPO PR
//   node scripts/codex-review.mjs land    OWNER/REPO PR [--method squash|merge|rebase]
//
// Findings file: {"summary": "...", "findings": [{"path": "a/b.ts",
// "line": 12, "priority": "P1", "title": "...", "body": "..."}]}. An empty
// findings list passes the commit. `line` is the line in the PR's version
// of the file; a finding off the diff goes in the review body instead of
// inline.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const CONTEXT = "codex-clean";
export const MARKER = "codex-review:v1";
const PRIORITIES = ["P0", "P1", "P2", "P3"];
const OK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

const home = process.env.CODEX_REVIEW_HOME ?? join(homedir(), "dev", ".clankie-checks", "codex-review");

function gh(args, input) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "inherit"],
  });
}
const api = (path, ...rest) => JSON.parse(gh(["api", path, ...rest]) || "null");
const pages = (path) =>
  JSON.parse(gh(["api", "--paginate", "--slurp", path]) || "[]").flatMap((page) =>
    Array.isArray(page) ? page : (page.check_runs ?? page.workflow_runs ?? page.statuses ?? []),
  );
const git = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

function fail(message, code = 1) {
  console.error(`codex-review: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const [command, repo, pr, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const match = /^--([a-z-]+)$/u.exec(rest[i]);
    if (!match) fail(`unexpected argument ${rest[i]}`);
    flags[match[1]] = rest[i + 1];
    i += 1;
  }
  if (!command || !/^[\w.-]+\/[\w.-]+$/u.test(repo ?? "") || !/^\d+$/u.test(pr ?? "")) {
    fail("usage: codex-review.mjs prepare|post|status|land OWNER/REPO PR [flags]");
  }
  return { command, repo, pr: Number(pr), flags };
}

const short = (sha) => sha.slice(0, 7);
const pull = (repo, pr) => api(`repos/${repo}/pulls/${pr}`);

/** Every line number on the PR side of the diff that GitHub accepts an inline comment on. */
export function commentableLines(files) {
  const lines = new Map();
  for (const file of files) {
    const set = new Set();
    let next = 0;
    for (const row of (file.patch ?? "").split("\n")) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(row);
      if (hunk) {
        next = Number(hunk[1]);
      } else if (row.startsWith("+") || row.startsWith(" ")) {
        set.add(next);
        next += 1;
      }
    }
    lines.set(file.filename, set);
  }
  return lines;
}

export function readFindings(text) {
  const parsed = JSON.parse(text);
  const findings = parsed.findings ?? [];
  if (!Array.isArray(findings)) throw new Error("findings must be a list");
  for (const [index, finding] of findings.entries()) {
    const where = `finding ${index + 1}`;
    if (typeof finding.title !== "string" || !finding.title.trim()) throw new Error(`${where} needs a title`);
    if (typeof finding.body !== "string" || !finding.body.trim()) throw new Error(`${where} needs a body`);
    if (!PRIORITIES.includes(finding.priority))
      throw new Error(`${where} priority must be one of ${PRIORITIES}`);
    if (finding.path !== undefined && typeof finding.path !== "string")
      throw new Error(`${where} path must be text`);
    if (finding.line !== undefined && !Number.isInteger(finding.line))
      throw new Error(`${where} line must be a number`);
  }
  return { summary: typeof parsed.summary === "string" ? parsed.summary.trim() : "", findings };
}

/** The review body and inline comments for one head commit. */
export function reviewPayload({ head, summary, findings, lines }) {
  const comments = [];
  const offDiff = [];
  for (const finding of findings) {
    const text = `**${finding.priority} ${finding.title.trim()}**\n\n${finding.body.trim()}`;
    if (finding.path && finding.line && lines.get(finding.path)?.has(finding.line)) {
      comments.push({ path: finding.path, line: finding.line, side: "RIGHT", body: text });
    } else {
      const where = finding.path ? ` (\`${finding.path}${finding.line ? `:${finding.line}` : ""}\`)` : "";
      offDiff.push(`- **${finding.priority} ${finding.title.trim()}**${where}: ${finding.body.trim()}`);
    }
  }
  const count = findings.length;
  const verdict =
    count === 0
      ? "No findings. This commit passes."
      : `${count} finding${count === 1 ? "" : "s"} to fix before this merges.`;
  const body = [
    "## Codex review",
    `Reviewed \`${short(head)}\` on the owner's Mac. ${verdict}`,
    summary,
    offDiff.length ? `Outside the diff:\n\n${offDiff.join("\n")}` : "",
    `<!-- ${MARKER} ${JSON.stringify({ commit: head, findings: count })} -->`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { commit_id: head, event: "COMMENT", body, comments };
}

function setStatus(repo, sha, state, description, targetUrl) {
  const args = [
    "api",
    "-X",
    "POST",
    `repos/${repo}/statuses/${sha}`,
    "-f",
    `state=${state}`,
    "-f",
    `context=${CONTEXT}`,
  ];
  args.push("-f", `description=${description.slice(0, 140)}`);
  if (targetUrl) args.push("-f", `target_url=${targetUrl}`);
  gh(args);
}

function previousReviews(repo, pr) {
  return pages(`repos/${repo}/pulls/${pr}/reviews?per_page=100`)
    .map((review) => {
      const match = new RegExp(`${MARKER} (\\{.*?\\})`, "u").exec(review.body ?? "");
      if (!match) return null;
      const state = JSON.parse(match[1]);
      return { commit: state.commit, findings: state.findings, url: review.html_url };
    })
    .filter(Boolean);
}

function prepare(repo, pr) {
  const info = pull(repo, pr);
  if (info.state !== "open") fail(`#${pr} is ${info.merged_at ? "merged" : info.state}`);
  const head = info.head.sha;
  const name = repo.split("/")[1];
  const mirror = join(home, `${name}.git`);
  mkdirSync(home, { recursive: true });
  if (!existsSync(mirror)) {
    gh(["repo", "clone", repo, mirror, "--", "--bare", "--filter=blob:none", "--quiet"]);
    git(["config", "credential.helper", "!gh auth git-credential"], mirror);
  }
  git(
    [
      "fetch",
      "--quiet",
      "origin",
      `+refs/pull/${pr}/head:refs/codex-review/pr-${pr}`,
      `+refs/heads/${info.base.ref}:refs/codex-review/base-${info.base.ref}`,
    ],
    mirror,
  );
  const fetched = git(["rev-parse", `refs/codex-review/pr-${pr}`], mirror);
  if (fetched !== head)
    fail(`#${pr} moved while fetching (${short(fetched)} vs ${short(head)}); prepare again`);
  const mergeBase = git(["merge-base", `refs/codex-review/base-${info.base.ref}`, head], mirror);
  const worktree = join(home, `${name}-pr${pr}-${short(head)}`);
  if (!existsSync(worktree)) git(["worktree", "add", "--quiet", "--detach", worktree, head], mirror);
  const findings = `${worktree}.findings.json`;
  if (!existsSync(findings))
    writeFileSync(findings, `${JSON.stringify({ summary: "", findings: [] }, null, 2)}\n`);
  setStatus(repo, head, "pending", `Codex is reviewing ${short(head)} on the owner's Mac`);
  console.log(
    JSON.stringify(
      {
        repo,
        pr,
        title: info.title,
        draft: info.draft,
        head,
        base: info.base.ref,
        mergeBase,
        worktree,
        findings,
        diff: `git -C ${worktree} diff ${mergeBase}..${head}`,
        previous: previousReviews(repo, pr),
        post: `node ${resolve(import.meta.filename)} post ${repo} ${pr} --head ${head} --findings ${findings}`,
      },
      null,
      2,
    ),
  );
}

function post(repo, pr, flags) {
  if (!/^[0-9a-f]{40}$/u.test(flags.head ?? ""))
    fail("--head must be the full head sha that prepare printed");
  if (!flags.findings) fail("--findings FILE is required");
  let review;
  try {
    review = readFindings(readFileSync(flags.findings, "utf8"));
  } catch (error) {
    fail(`findings file: ${error.message}`);
  }
  const info = pull(repo, pr);
  if (info.state !== "open") fail(`#${pr} is ${info.merged_at ? "merged" : info.state}; nothing posted`);
  if (info.head.sha !== flags.head) {
    fail(
      `#${pr} moved to ${short(info.head.sha)} since ${short(flags.head)}; nothing posted, prepare again`,
      2,
    );
  }
  const lines = commentableLines(pages(`repos/${repo}/pulls/${pr}/files?per_page=100`));
  const payload = reviewPayload({ head: flags.head, ...review, lines });
  const posted = JSON.parse(
    gh(["api", "-X", "POST", `repos/${repo}/pulls/${pr}/reviews`, "--input", "-"], JSON.stringify(payload)),
  );
  const count = review.findings.length;
  if (count === 0) {
    setStatus(repo, flags.head, "success", `Codex passed ${short(flags.head)}: no findings`, posted.html_url);
  } else {
    setStatus(
      repo,
      flags.head,
      "failure",
      `Codex found ${count} to fix on ${short(flags.head)}`,
      posted.html_url,
    );
  }
  console.log(
    JSON.stringify({ review: posted.html_url, head: flags.head, findings: count, passed: count === 0 }),
  );
}

/** When the pull request last became ready for review: its last ready event, or its opening. */
function readySince(repo, pr, info) {
  const ready = pages(`repos/${repo}/issues/${pr}/events?per_page=100`).filter(
    (event) => event.event === "ready_for_review",
  );
  return ready.at(-1)?.created_at ?? info.created_at;
}

/**
 * Check suites whose workflow runs again when a draft is marked ready. A job
 * such a workflow skipped before that moment was skipped for the draft, so it
 * has not run yet.
 */
function rerunOnReady(repo, sha) {
  const suites = new Set();
  const listens = new Map();
  for (const run of pages(`repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`)) {
    if (!listens.has(run.path)) {
      let text = "";
      try {
        const file = api(`repos/${repo}/contents/${run.path}?ref=${sha}`);
        text = Buffer.from(file.content ?? "", "base64").toString("utf8");
      } catch {
        text = "ready_for_review"; // unreadable workflow: assume it reruns, so nothing is waved through
      }
      listens.set(run.path, /\bready_for_review\b/u.test(text));
    }
    if (listens.get(run.path)) suites.add(run.check_suite_id);
  }
  return suites;
}

/**
 * codex-clean on the head plus every other status and check run there. A
 * job skipped before `since` in a workflow that reruns when the pull request
 * is marked ready counts as still to run, so `land` cannot merge in the gap
 * before the ready checks start.
 */
export function judgeChecks({ statuses: statusList, runs: runList, since, rerunSuites }) {
  const statuses = new Map();
  for (const status of statusList) {
    if (!statuses.has(status.context)) statuses.set(status.context, status.state); // newest first
  }
  const codex = statuses.get(CONTEXT) ?? "missing";
  statuses.delete(CONTEXT);
  const pending = [];
  const failing = [];
  for (const [name, state] of statuses) {
    if (state === "pending") pending.push(name);
    else if (state !== "success") failing.push(`${name} (${state})`);
  }
  for (const run of runList) {
    const state = run.status === "completed" ? run.conclusion : run.status;
    const draftSkip =
      state === "skipped" && since && run.completed_at < since && rerunSuites.has(run.check_suite?.id);
    if (draftSkip) pending.push(`${run.name} (not run since ready)`);
    else if (run.status !== "completed") pending.push(run.name);
    else if (!OK_CONCLUSIONS.has(state)) failing.push(`${run.name} (${state})`);
  }
  return { codex, pending, failing };
}

function headChecks(repo, sha, since) {
  return judgeChecks({
    statuses: pages(`repos/${repo}/commits/${sha}/statuses?per_page=100`),
    runs: pages(`repos/${repo}/commits/${sha}/check-runs?per_page=100&filter=latest`),
    since,
    rerunSuites: since ? rerunOnReady(repo, sha) : new Set(),
  });
}

function status(repo, pr) {
  const info = pull(repo, pr);
  const checks = headChecks(repo, info.head.sha, info.draft ? undefined : readySince(repo, pr, info));
  console.log(
    JSON.stringify(
      {
        repo,
        pr,
        state: info.merged_at ? "merged" : info.state,
        draft: info.draft,
        head: info.head.sha,
        ...checks,
      },
      null,
      2,
    ),
  );
}

function land(repo, pr, flags) {
  const method = flags.method ?? "squash";
  if (!["squash", "merge", "rebase"].includes(method)) fail("--method is squash, merge or rebase");
  const info = pull(repo, pr);
  if (info.state !== "open") fail(`#${pr} is ${info.merged_at ? "already merged" : info.state}`);
  if (info.draft) fail(`#${pr} is a draft; mark it ready first`, 3);
  const head = info.head.sha;
  const { codex, pending, failing } = headChecks(repo, head, readySince(repo, pr, info));
  if (codex !== "success") {
    fail(`Codex has not passed ${short(head)} (${CONTEXT}: ${codex}); ask the Mac reviewer for a review`, 3);
  }
  if (failing.length) fail(`checks failing on ${short(head)}: ${failing.join(", ")}`);
  if (pending.length) fail(`still running on ${short(head)}: ${pending.join(", ")}`, 3);
  const args = [
    "api",
    "-X",
    "PUT",
    `repos/${repo}/pulls/${pr}/merge`,
    "-f",
    `merge_method=${method}`,
    "-f",
    `sha=${head}`,
  ];
  if (method === "squash") args.push("-f", `commit_title=${info.title} (#${pr})`);
  const merged = JSON.parse(gh(args));
  console.log(JSON.stringify({ merged: merged.merged, sha: merged.sha, head }));
}

if (import.meta.filename === resolve(process.argv[1] ?? "")) {
  const { command, repo, pr, flags } = parseArgs(process.argv.slice(2));
  const commands = { prepare, post, status, land };
  if (!commands[command]) fail(`unknown command ${command}`);
  try {
    commands[command](repo, pr, flags);
  } catch (error) {
    const detail = error.stdout?.trim() || error.message;
    fail(`${error.cmd ?? command} failed: ${detail}`);
  }
}
