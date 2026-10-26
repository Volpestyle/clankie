import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { updateCommit } from "../../tui/bin/pinned-runtime.ts";
import type { RuntimeUpdater } from "../../tui/bin/runtime-updater.ts";
import { DeployHolds } from "../src/deploy-holds.ts";
import { INTEGRATION_UPDATE_MAX_FAILURES, integrationSafeUpdates } from "../src/integration-update.ts";

// Real Git throughout: a scratch bare origin and a clone that is behind it.
const roots: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  closers.splice(0).forEach((close) => close());
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

it("refuses an unknown abbreviation", async () => {
  const f = fixture();
  await expect(updateCommit(f.checkout, "deadbeef0", f.base, run)).rejects.toThrow();
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

function waiting(f: ReturnType<typeof fixture>, options: { gaveUp: string[]; errors: unknown[] }) {
  const holds = new DeployHolds(join(f.root, "holds"));
  const updater = {
    runtime: { root: f.checkout, commit: f.base, instanceId: "i", pid: 1 },
    status: () => ({ runtime: { root: f.checkout, commit: f.base, instanceId: "i", pid: 1 } }),
    preview: async (ref: string) => ({
      ref,
      ...(await updateCommit(f.checkout, ref, f.base, run)),
      commitCount: 1,
      summary: [],
    }),
    request: async (ref: string) => {
      await updateCommit(f.checkout, ref, f.base, run);
      return { ...updater.status(), accepted: true };
    },
  } as unknown as RuntimeUpdater;
  const wrapped = integrationSafeUpdates({
    updater,
    holds,
    path: join(f.root, "updates", "integration-wait.json"),
    intervalMs: 1_000_000,
    onError: (error) => options.errors.push(error),
    onGaveUp: (message) => options.gaveUp.push(message),
  });
  closers.push(() => wrapped.close());
  const authority = { guard: async () => {}, current: () => true };
  return { holds, wrapped, authority };
}

it("refuses an unresolvable ref at request time without a durable waiting intent", async () => {
  const f = fixture();
  const w = waiting(f, { gaveUp: [], errors: [] });
  const batch = randomUUID();
  await w.holds.acquire({
    id: batch,
    holder: "Integration batch",
    reason: "gate",
    minutes: 60,
    integrationBatchId: batch,
  });
  await expect(w.wrapped.request("2f1add276", w.authority)).rejects.toThrow(/could not be resolved now/);
  expect(w.wrapped.status().pending).toBeUndefined();
  expect(existsSync(join(f.root, "updates", "integration-wait.json"))).toBe(false);
  // A resolvable short SHA waits normally.
  const queued = await w.wrapped.request(f.next.slice(0, 9), w.authority);
  expect(queued.waitingForIntegration?.ref).toBe(f.next.slice(0, 9));
});

it("gives up after bounded fetch failures, releases the integrate fence and tells the lead", async () => {
  const f = fixture();
  const gaveUp: string[] = [];
  const errors: unknown[] = [];
  const w = waiting(f, { gaveUp, errors });
  const batch = randomUUID();
  await w.holds.acquire({
    id: batch,
    holder: "Integration batch",
    reason: "gate",
    minutes: 60,
    integrationBatchId: batch,
  });
  await w.wrapped.request("feature", w.authority); // resolves while origin is reachable
  expect(w.wrapped.status().pending).toBeDefined();
  // The dispatcher's fence refuses new batches while the update is pending.
  const fenced = w.holds.integration(
    randomUUID(),
    () => w.wrapped.status().pending !== undefined,
    async () => "ran",
  );
  const early = await Promise.race([
    fenced,
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 600)),
  ]);
  expect(early).toBe("blocked");
  await w.holds.release(batch, "fixture", "gate ended");
  renameSync(f.origin, `${f.origin}.gone`); // every later fetch fails, like the 15 s loop in VUH-2794
  for (let attempt = 1; attempt <= INTEGRATION_UPDATE_MAX_FAILURES; attempt++) {
    expect(w.wrapped.status().pending).toBeDefined();
    await w.wrapped.check();
  }
  expect(errors).toHaveLength(INTEGRATION_UPDATE_MAX_FAILURES - 1);
  expect(w.wrapped.status().pending).toBeUndefined();
  expect(w.wrapped.status().waitingForIntegration).toBeUndefined();
  expect(gaveUp).toHaveLength(1);
  expect(gaveUp[0]).toContain("feature");
  expect(gaveUp[0]).toContain(String(INTEGRATION_UPDATE_MAX_FAILURES));
  // The fenced batch is admitted now that nothing is pending.
  expect(await fenced).toBe("ran");
  await w.wrapped.check();
  expect(gaveUp).toHaveLength(1);
});
