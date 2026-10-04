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
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

const supported = new Set(["100644", "100755", "120000"]);
const blob = (rev, path) => {
  const entry = gitBuffer("ls-tree", "-z", rev, "--", `:(literal)${path}`).toString();
  if (!entry) return undefined;
  const mode = entry.slice(0, 6);
  if (!supported.has(mode)) fail(`${path}: unsupported Git mode ${mode}; nothing was changed.`);
  return { mode, content: gitBuffer("cat-file", "blob", `${rev}:${path}`) };
};
const stat = (path) => {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
};
const read = (path) => {
  // Never traverse a directory link, including for a new path below one.
  const parents = [];
  for (let parent = dirname(path); parent !== "."; parent = dirname(parent)) parents.unshift(parent);
  for (const parent of parents) {
    const info = stat(parent);
    if (info && !info.isDirectory()) fail(`${parent}: unsupported parent type; nothing was changed.`);
  }
  const info = stat(path);
  if (!info) return undefined;
  if (info.isSymbolicLink()) return { mode: "120000", content: readlinkSync(path, { encoding: "buffer" }) };
  if (!info.isFile()) fail(`${path}: unsupported working-tree type; nothing was changed.`);
  return { mode: info.mode & 0o100 ? "100755" : "100644", content: readFileSync(path) };
};
const same = (a, b) =>
  a === undefined ? b === undefined : b !== undefined && a.mode === b.mode && a.content.equals(b.content);

const changed = gitBuffer("diff", "--name-only", "--no-renames", "-z", head, target)
  .toString()
  .split("\0")
  .filter(Boolean);
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
  if (clash)
    fail(`${path} reuses ADR ${number}, already taken by uncommitted ${clash}; renumber it on ${branch}.`);
}

const writes = [];
const scratch = mkdtempSync(join(tmpdir(), "land-"));
try {
  for (const path of changed) {
    const base = blob(head, path);
    const theirs = blob(target, path);
    const ours = read(path);
    if (same(ours, base) || same(ours, theirs)) {
      if (!same(ours, theirs)) writes.push({ path, entry: theirs });
      continue;
    }
    // Someone else's uncommitted edit (or untracked file) is in this path.
    if (same(theirs, base)) continue;
    if (base === undefined || theirs === undefined || ours === undefined)
      fail(`${path}: uncommitted work and ${branch} both add or delete it; resolve with its owner.`);
    if ([base, ours, theirs].some((entry) => entry.mode === "120000"))
      fail(`${path}: uncommitted link/type change overlaps ${branch}; resolve with its owner.`);
    const mode =
      ours.mode === base.mode
        ? theirs.mode
        : theirs.mode === base.mode || ours.mode === theirs.mode
          ? ours.mode
          : undefined;
    if (!mode) fail(`${path}: conflicting file modes; resolve with its owner.`);
    const files = ["ours", "base", "theirs"].map((name) => join(scratch, name));
    writeFileSync(files[0], ours.content);
    writeFileSync(files[1], base.content);
    writeFileSync(files[2], theirs.content);
    const merged = spawnSync("git", ["merge-file", "-p", ...files], { maxBuffer: 1 << 28 });
    if (merged.status !== 0)
      fail(`${path}: ${branch} conflicts with uncommitted work there; resolve with its owner.`);
    writes.push({ path, entry: { mode, content: merged.stdout }, merged: true });
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
for (const { path, entry } of writes) {
  // Remove the entry itself, never write through a link (even a dangling one).
  const previous = stat(path);
  if (previous) unlinkSync(path);
  if (entry === undefined) continue;
  mkdirSync(dirname(path), { recursive: true });
  if (entry.mode === "120000") symlinkSync(entry.content, path);
  else {
    // Creation modes respect umask. Existing regular files keep private read/write
    // permissions; a Git executable change adds execute only for readable classes.
    const executable = entry.mode === "100755";
    let permissions = executable ? 0o755 : 0o644;
    if (previous?.isFile()) {
      permissions = previous.mode & 0o777;
      if (Boolean(permissions & 0o100) !== executable)
        permissions = (permissions & ~0o111) | (executable ? ((permissions & 0o444) >> 2) | 0o100 : 0);
    }
    writeFileSync(path, entry.content, { mode: permissions });
    if (previous?.isFile()) chmodSync(path, permissions);
  }
}
spawnSync("git", ["update-index", "-q", "--refresh"]);
console.log(`Landed. ${current} is now ${target.slice(0, 8)}; uncommitted work elsewhere is untouched.`);
