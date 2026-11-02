import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { updateCommit } from "../../tui/bin/pinned-runtime.ts";

// Real Git throughout: a scratch bare origin and a clone that is behind it.
const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
const run = async (_command: string, args: readonly string[], cwd: string) => git(cwd, ...args);

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "clankie-update-ref-")));
  roots.push(root);
  const origin = join(root, "origin.git");
  const checkout = join(root, "checkout");
  const author = join(root, "author");
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "clone", origin, author);
  git(author, "commit", "--allow-empty", "-m", "base");
  git(author, "push", "origin", "HEAD:main");
  git(root, "clone", origin, checkout);
  const base = git(checkout, "rev-parse", "HEAD");
  // Lands after the clone, so the checkout can only learn it by fetching main.
  git(author, "commit", "--allow-empty", "-m", "next");
  git(author, "push", "origin", "HEAD:main", "HEAD:refs/heads/feature");
  const next = git(author, "rev-parse", "HEAD");
  return { root, origin, checkout, author, base, next };
}

it("resolves short and full SHAs as commits fetched from main, never as a branch", async () => {
  const f = fixture();
  expect(() => git(f.checkout, "cat-file", "-e", `${f.next}^{commit}`)).toThrow();
  for (const ref of [f.next.slice(0, 9), f.next]) {
    const target = await updateCommit(f.checkout, ref, f.base, run);
    expect(target).toMatchObject({ newCommit: f.next, resolvedRef: f.next });
  }
  // The pre-fix resolver fetched +refs/heads/<sha>:refs/remotes/origin/<sha>.
  expect(git(f.checkout, "for-each-ref", `refs/remotes/origin/${f.next.slice(0, 9)}`)).toBe("");
});

it("resolves a local-only commit by SHA without reaching origin", async () => {
  const f = fixture();
  git(f.checkout, "commit", "--allow-empty", "-m", "local only");
  const local = git(f.checkout, "rev-parse", "HEAD");
  renameSync(f.origin, `${f.origin}.gone`);
  for (const ref of [local.slice(0, 8), local])
    expect(await updateCommit(f.checkout, ref, f.base, run)).toMatchObject({ newCommit: local });
});

it("refuses an unknown abbreviation or branch with git's reason, not its command line (#377)", async () => {
  const f = fixture();
  await expect(updateCommit(f.checkout, "deadbeef0", f.base, run)).rejects.toThrow(
    /^Update ref "deadbeef0" could not be resolved now: fatal: Needed a single revision$/u,
  );
  await expect(updateCommit(f.checkout, "no-such-branch", f.base, run)).rejects.toThrow(
    /^Update ref "no-such-branch" could not be resolved now: fatal: couldn't find remote ref/u,
  );
});

it("refuses a 7-digit prefix shared by a local old commit and a fetched-only new commit", async () => {
  const f = fixture();
  // 60k unrelated root commits in one fast-import; 28-bit prefixes collide a handful of times.
  const marks = join(f.root, "marks");
  const stream = Array.from(
    { length: 60_000 },
    (_, i) =>
      `reset refs/tmp/pool\ncommit refs/tmp/pool\nmark :${i + 1}\ncommitter t <t@t> ${1_700_000_000 + i} +0000\ndata 1\nx\n\n`,
  ).join("");
  execFileSync("git", ["fast-import", "--quiet", `--export-marks=${marks}`], {
    cwd: f.author,
    input: stream,
    maxBuffer: 1 << 28,
  });
  const byPrefix = new Map<string, string>();
  let pair: [string, string] | undefined;
  for (const line of readFileSync(marks, "utf8").trim().split("\n")) {
    const sha = line.split(" ")[1]!;
    const earlier = byPrefix.get(sha.slice(0, 7));
    if (earlier) {
      pair = [earlier, sha];
      break;
    }
    byPrefix.set(sha.slice(0, 7), sha);
  }
  expect(pair).toBeDefined();
  const [old, landed] = pair!;
  // The checkout already holds the old commit; origin main then moves to the colliding one.
  git(f.author, "push", "origin", `${old}:refs/heads/old`);
  git(f.checkout, "fetch", "origin", "refs/heads/old:refs/heads/old");
  git(f.author, "push", "origin", "--delete", "old");
  git(f.author, "push", "origin", "--force", `${landed}:refs/heads/main`);
  const prefix = old.slice(0, 7);
  expect(git(f.checkout, "rev-parse", `${prefix}^{commit}`)).toBe(old); // resolves locally on its own
  await expect(updateCommit(f.checkout, prefix, f.base, run)).rejects.toThrow(/ambiguous|short object/i);
  // The full SHA stays exact.
  expect(await updateCommit(f.checkout, landed, f.base, run)).toMatchObject({ newCommit: landed });
}, 120_000);

it("keeps hex-named branches reachable as refs/heads/NAME and origin/NAME, not as bare names", async () => {
  const f = fixture();
  git(f.author, "commit", "--allow-empty", "-m", "hex branch");
  git(f.author, "push", "origin", "HEAD:refs/heads/abcdef1234");
  const tip = git(f.author, "rev-parse", "HEAD");
  for (const ref of ["refs/heads/abcdef1234", "origin/abcdef1234"])
    expect(await updateCommit(f.checkout, ref, f.base, run)).toMatchObject({
      newCommit: tip,
      resolvedRef: "refs/remotes/origin/abcdef1234",
    });
  // A bare hex name is a commit lookup, and no object has that name.
  await expect(updateCommit(f.checkout, "abcdef1234", f.base, run)).rejects.toThrow();
});

it("falls back to local objects for an abbreviation when origin is unreachable", async () => {
  const f = fixture();
  renameSync(f.origin, `${f.origin}.gone`);
  expect(await updateCommit(f.checkout, f.base.slice(0, 7), f.base, run)).toMatchObject({
    newCommit: f.base,
  });
});

it("accepts a synchronous runner that throws before the fetch", async () => {
  const f = fixture();
  const sync = (_command: string, args: readonly string[], cwd: string) => git(cwd, ...args);
  expect(await updateCommit(f.checkout, f.next, f.base, sync)).toMatchObject({ newCommit: f.next });
});
