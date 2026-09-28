import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { annotateLibraryVcs, pullCandidates, syncWorktrees, scanWorktrees, fetchRepo } from "./lib.ts";
import type { LibraryEntry } from "./types.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "hl-synctest-"));
process.on("exit", () => fs.rmSync(ROOT, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const hasRef = (cwd: string, ref: string): boolean => {
  try { execFileSync("git", ["-C", cwd, "show-ref", "--verify", "--quiet", ref], { stdio: "ignore" }); return true; }
  catch { return false; }
};

const origin = path.join(ROOT, "origin.git");
execFileSync("git", ["init", "--bare", "-b", "main", origin]);
const seed = path.join(ROOT, "seed");
execFileSync("git", ["clone", origin, seed], { stdio: "ignore" });
git(seed, "config", "user.email", "t@t");
git(seed, "config", "user.name", "t");
fs.writeFileSync(path.join(seed, "a.txt"), "1\n");
git(seed, "add", "-A");
git(seed, "commit", "-m", "one");
git(seed, "push", "-u", "origin", "main");

git(seed, "checkout", "-b", "landed-feature");
fs.writeFileSync(path.join(seed, "landed.txt"), "landed\n");
git(seed, "add", "-A");
git(seed, "commit", "-m", "feature version");
const featureHead = git(seed, "rev-parse", "HEAD");
git(seed, "push", "-u", "origin", "landed-feature");
git(seed, "checkout", "main");
git(seed, "cherry-pick", "-x", featureHead);
git(seed, "push");

const mk = (name: string): string => {
  const d = path.join(ROOT, name);
  execFileSync("git", ["clone", origin, d], { stdio: "ignore" });
  git(d, "config", "user.email", "t@t");
  git(d, "config", "user.name", "t");
  return d;
};
const behind = mk("behind");
const dirty = mk("dirty");
const diverged = mk("diverged");
const noUpstream = mk("noUpstream");
const busyOne = mk("busy");
const landed = path.join(ROOT, "landed");
execFileSync("git", ["clone", "--branch", "landed-feature", origin, landed], { stdio: "ignore" });
const linkedA = path.join(ROOT, "linked-a");
const linkedB = path.join(ROOT, "linked-b");
git(seed, "branch", "linked-a", "origin/main");
git(seed, "branch", "linked-b", "origin/main");
execFileSync("git", ["-C", seed, "worktree", "add", linkedA, "linked-a"], { stdio: "ignore" });
execFileSync("git", ["-C", seed, "worktree", "add", linkedB, "linked-b"], { stdio: "ignore" });
git(linkedA, "branch", "--set-upstream-to", "origin/main");
git(linkedB, "branch", "--set-upstream-to", "origin/main");

fs.writeFileSync(path.join(seed, "a.txt"), "2\n");
git(seed, "commit", "-am", "two");
git(seed, "push");
const wantHead = git(seed, "rev-parse", "HEAD");

fs.writeFileSync(path.join(dirty, "a.txt"), "local edit\n");
fs.writeFileSync(path.join(diverged, "b.txt"), "x\n");
git(diverged, "add", "-A");
git(diverged, "commit", "-m", "local only");
const divergedHead = git(diverged, "rev-parse", "HEAD");
git(noUpstream, "checkout", "-b", "solo", "--quiet");

const wts = await scanWorktrees([ROOT]);
const byName = Object.fromEntries(wts.map((w) => [w.name, w]));
const worktree = (name: string) => {
  const found = byName[name];
  assert.ok(found, `missing ${name}`);
  return found;
};
for (const name of ["behind", "dirty", "diverged", "noUpstream", "busy", "landed", "linked-a", "linked-b"]) worktree(name);
assert.equal(worktree("landed").unique, 0, "patch-equivalent commits already on main must not count as unlanded");

const busy = new Set([worktree("busy").dir]);
const { go, skip } = pullCandidates(wts, busy);
const skipWhy = Object.fromEntries(skip.map((s) => [s.w.name, s.why]));
assert.equal(skipWhy.dirty, "1 uncommitted", "dirty worktree must be skipped");
assert.equal(skipWhy.noUpstream, "no upstream", "branch with no upstream must be skipped");
assert.equal(skipWhy.busy, "agent working here", "worktree with a working agent must be skipped");
assert.ok(go.some((w) => w.name === "behind"), "behind worktree should be a candidate");
assert.ok(go.some((w) => w.name === "diverged"), "diverged is a candidate; --ff-only must reject it");

const res = await syncWorktrees(wts, busy, () => {});
const names = (xs: Array<{ w: { name: string } }>): string[] => xs.map((x) => x.w.name).sort();

assert.ok(names(res.updated).includes("behind"), `behind should have fast-forwarded, got ${names(res.updated)}`);
assert.equal(git(behind, "rev-parse", "HEAD"), wantHead, "behind did not reach origin HEAD");
assert.ok(names(res.updated).includes("linked-a"), "first linked worktree did not update");
assert.ok(names(res.updated).includes("linked-b"), "second linked worktree did not update");
assert.equal(git(linkedA, "rev-parse", "HEAD"), wantHead, "first linked worktree did not reach origin HEAD");
assert.equal(git(linkedB, "rev-parse", "HEAD"), wantHead, "second linked worktree did not reach origin HEAD");

assert.ok(names(res.failed).includes("diverged"), "diverged must fail, not merge");
assert.equal(git(diverged, "rev-parse", "HEAD"), divergedHead, "diverged HEAD was mutated — unsafe!");

assert.equal(fs.readFileSync(path.join(dirty, "a.txt"), "utf8"), "local edit\n", "dirty worktree was clobbered!");
assert.notEqual(git(busyOne, "rev-parse", "HEAD"), wantHead, "busy worktree was updated despite a working agent");
assert.equal(git(noUpstream, "symbolic-ref", "--short", "HEAD"), "solo", "noUpstream branch changed");

const landedHead = git(landed, "rev-parse", "HEAD");
git(seed, "push", "origin", "--delete", "landed-feature");
const fetched = await fetchRepo(worktree("landed"));
assert.equal(fetched.ok, true, fetched.err);
assert.equal(git(landed, "rev-parse", "HEAD"), landedHead, "fetch-only refresh changed the selected worktree");
assert.equal(hasRef(landed, "refs/remotes/origin/landed-feature"), false,
  "fetch-only refresh did not prune the deleted remote-tracking ref");

const skillDir = path.join(seed, "nested", "skill");
const skillFile = path.join(skillDir, "SKILL.md");
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(skillFile, "test\n");
const library: LibraryEntry[] = [{
  rootIdx: 0,
  name: "skill",
  group: "nested",
  file: skillFile,
  dir: skillDir,
  real: skillDir,
  links: [],
  aliases: [],
  mtime: Date.now(),
  size: 5,
  doc: false,
  vcs: null,
}];
await annotateLibraryVcs(library);
assert.equal(library[0]?.vcs?.repo, "seed", "library scan did not find the containing repository");
assert.equal(library[0]?.vcs?.state, "new", "untracked nested skill was not classified as new");

console.log("updated:", names(res.updated), "| failed:", names(res.failed), "| unchanged:", res.unchanged);
console.log("skipped:", skip.map((s) => `${s.w.name}(${s.why})`).join(", "));
console.log("SYNC SAFETY CHECKS PASSED");
