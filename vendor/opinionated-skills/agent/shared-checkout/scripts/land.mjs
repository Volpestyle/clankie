#!/usr/bin/env node
// Land a reviewed branch onto the current branch of a checkout that other
// agents still have uncommitted work in, without touching that work.
//
//   node land.mjs <branch> [--dry-run]
//
// The branch must already contain HEAD (rebase it first). HEAD then moves to
// the branch exactly, so its commits and tested tree land unchanged. Each
// changed path in the working tree becomes the branch's version when nobody
// edited it, or a clean three-way merge of the owner's edit and the branch when
// someone did. Any conflict, a staged index, an untracked file in the way, or
// a new ADR number already taken by uncommitted work refuses before anything
// is written.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const branch = args.find((arg) => !arg.startsWith("--"));
if (!branch || args.length > (dryRun ? 2 : 1)) fail("Usage: land.mjs <branch> [--dry-run]");

const git = (...gitArgs) => execFileSync("git", gitArgs, { encoding: "utf8", maxBuffer: 1 << 28 }).trimEnd();
const gitBuffer = (...gitArgs) => execFileSync("git", gitArgs, { maxBuffer: 1 << 28 });
function fail(message) {
  console.error(`land: ${message}`);
  process.exit(1);
}

const root = git("rev-parse", "--show-toplevel");
process.chdir(root);
const head = git("rev-parse", "HEAD");
const target = git("rev-parse", "--verify", `${branch}^{commit}`);
const current = git("symbolic-ref", "--quiet", "--short", "HEAD");
if (head === target) fail(`${branch} is already landed on ${current}.`);
if (spawnSync("git", ["merge-base", "--is-ancestor", head, target]).status !== 0)
  fail(`${branch} does not contain ${current} (${head.slice(0, 8)}); rebase it onto ${current} first.`);
if (git("diff", "--cached", "--name-only") !== "")
  fail("the index has staged changes; another agent may be mid-commit. Wait or coordinate.");

const blob = (rev, path) => {
  const result = spawnSync("git", ["cat-file", "blob", `${rev}:${path}`], { maxBuffer: 1 << 28 });
  return result.status === 0 ? result.stdout : undefined;
};
const read = (path) => (existsSync(path) ? readFileSync(path) : undefined);
const same = (a, b) => (a === undefined ? b === undefined : b !== undefined && a.equals(b));

const changed = git("diff", "--name-only", "--no-renames", head, target).split("\n").filter(Boolean);
const dirty = new Set(
  git("status", "--porcelain", "--untracked-files=all", "-z")
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3)),
);

// A new ADR whose number uncommitted work already uses.
const adrNumber = (path) => /^docs\/adr\/(\d{4})-/u.exec(path)?.[1];
for (const path of changed) {
  const number = adrNumber(path);
  if (!number || blob(head, path) !== undefined) continue;
  const clash = [...dirty].find((other) => other !== path && adrNumber(other) === number);
  if (clash) fail(`${path} reuses ADR ${number}, already taken by uncommitted ${clash}; renumber it on ${branch}.`);
}

const writes = [];
const scratch = mkdtempSync(join(tmpdir(), "land-"));
try {
  for (const path of changed) {
    const base = blob(head, path);
    const theirs = blob(target, path);
    const ours = read(path);
    if (same(ours, base) || same(ours, theirs)) {
      if (!same(ours, theirs)) writes.push({ path, content: theirs });
      continue;
    }
    // Someone else's uncommitted edit (or untracked file) is in this path.
    if (same(theirs, base)) continue;
    if (base === undefined || theirs === undefined || ours === undefined)
      fail(`${path}: uncommitted work and ${branch} both add or delete it; resolve with its owner.`);
    const files = ["ours", "base", "theirs"].map((name) => join(scratch, name));
    writeFileSync(files[0], ours);
    writeFileSync(files[1], base);
    writeFileSync(files[2], theirs);
    const merged = spawnSync("git", ["merge-file", "-p", ...files], { maxBuffer: 1 << 28 });
    if (merged.status !== 0) fail(`${path}: ${branch} conflicts with uncommitted work there; resolve with its owner.`);
    writes.push({ path, content: merged.stdout, merged: true });
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const mergedPaths = writes.filter((write) => write.merged).map((write) => write.path);
console.log(
  `${dryRun ? "Would land" : "Landing"} ${branch} (${target.slice(0, 8)}) onto ${current} (${head.slice(0, 8)}): ` +
    `${changed.length} paths, ${mergedPaths.length} merged around uncommitted work${mergedPaths.length ? `: ${mergedPaths.join(", ")}` : ""}.`,
);
if (dryRun) process.exit(0);

// The index matched HEAD, so it becomes the branch's tree; the ref moves only
// if nobody committed meanwhile, otherwise the index goes back.
gitBuffer("read-tree", target);
try {
  git("update-ref", "-m", `land ${branch}`, `refs/heads/${current}`, target, head);
} catch {
  gitBuffer("read-tree", head);
  fail(`${current} moved while landing; nothing was changed. Retry.`);
}
for (const { path, content } of writes) {
  if (content === undefined) {
    if (existsSync(path)) unlinkSync(path);
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
spawnSync("git", ["update-index", "-q", "--refresh"]);
console.log(`Landed. ${current} is now ${target.slice(0, 8)}; uncommitted work elsewhere is untouched.`);
