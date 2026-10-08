import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { CheckoutReportSchema } from "@clankie/protocol";
import {
  checkoutGit,
  inspectCheckout,
  reconcileWorktree,
  syncOwnerCheckout,
  unreconciledLinkedWorktrees,
  verifyHireCheckout,
} from "../src/checkouts.ts";
const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-checkouts-")));
  roots.push(root);
  const origin = join(root, "origin.git"),
    owner = join(root, "owner"),
    writer = join(root, "writer");
  await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
  await exec("git", ["clone", origin, owner]);
  await checkoutGit(owner, ["config", "user.name", "Checkout fixture"]);
  await checkoutGit(owner, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(owner, "incoming.txt"), "base\n");
  await writeFile(join(owner, "draft.txt"), "draft baseline\n");
  await writeFile(join(owner, ".gitignore"), "node_modules/\n.local/\nignored.txt\n");
  await checkoutGit(owner, ["add", "."]);
  await checkoutGit(owner, [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "baseline",
  ]);
  await checkoutGit(owner, ["push", "origin", "main"]);
  await exec("git", ["clone", origin, writer]);
  await checkoutGit(writer, ["config", "user.name", "Checkout fixture"]);
  await checkoutGit(writer, ["config", "user.email", "fixture@example.invalid"]);
  const base = (await checkoutGit(owner, ["rev-parse", "HEAD"])).trim();
  async function advance(file = "incoming.txt", text = "remote\n") {
    await writeFile(join(writer, file), text);
    await checkoutGit(writer, ["add", "-f", file]);
    await checkoutGit(writer, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "advance",
    ]);
    await checkoutGit(writer, ["push", "origin", "main"]);
    return (await checkoutGit(writer, ["rev-parse", "HEAD"])).trim();
  }
  return { root, origin, owner, writer, base, advance };
}
it("fast-forwards clean owner main and preserves disjoint staged, unstaged and untracked owner work", async () => {
  const f = await fixture();
  await writeFile(join(f.owner, "draft.txt"), "staged draft\n");
  await checkoutGit(f.owner, ["add", "draft.txt"]);
  await writeFile(join(f.owner, "draft.txt"), "later unstaged draft\n");
  await writeFile(join(f.owner, "untracked.txt"), "owner notes\n");
  const before = await checkoutGit(f.owner, ["status", "--porcelain=v1", "-z"]);
  const target = await f.advance();
  const linked = join(f.root, "integrator");
  await checkoutGit(f.owner, ["worktree", "add", "--detach", linked, f.base]);
  expect(await syncOwnerCheckout(linked)).toMatchObject({
    path: f.owner,
    outcome: "updated",
    before: f.base,
    after: target,
  });
  expect(await checkoutGit(f.owner, ["status", "--porcelain=v1", "-z"])).toBe(before);
  expect(await readFile(join(f.owner, "draft.txt"), "utf8")).toBe("later unstaged draft\n");
  expect(await readFile(join(f.owner, "incoming.txt"), "utf8")).toBe("remote\n");
  expect((await syncOwnerCheckout(f.owner)).outcome).toBe("current");
});
it("names overlapping edits and age, leaves main and the index unchanged even with autostash configured", async () => {
  const f = await fixture();
  await f.advance();
  await checkoutGit(f.owner, ["config", "merge.autoStash", "true"]);
  await writeFile(join(f.owner, "incoming.txt"), "owner edits\n");
  await utimes(join(f.owner, "incoming.txt"), new Date(0), new Date(Date.now() - 172800000));
  const before = await checkoutGit(f.owner, ["status", "--porcelain=v1", "-z"]);
  const result = await syncOwnerCheckout(f.owner);
  expect(result).toMatchObject({ outcome: "blocked", blockers: [{ path: "incoming.txt" }] });
  expect(result.blockers[0]!.ageSeconds).toBeGreaterThanOrEqual(172800);
  expect((await checkoutGit(f.owner, ["rev-parse", "HEAD"])).trim()).toBe(f.base);
  expect(await checkoutGit(f.owner, ["status", "--porcelain=v1", "-z"])).toBe(before);
  expect(await checkoutGit(f.owner, ["stash", "list"])).toBe("");
});
it("protects untracked and ignored incoming paths, local commits, non-main branches and failed fetches", async () => {
  const f = await fixture();
  await f.advance("ignored.txt");
  await writeFile(join(f.owner, "ignored.txt"), "private ignored notes\n");
  expect(await syncOwnerCheckout(f.owner)).toMatchObject({
    outcome: "blocked",
    blockers: [{ path: "ignored.txt" }],
  });
  expect(await readFile(join(f.owner, "ignored.txt"), "utf8")).toBe("private ignored notes\n");
  await writeFile(join(f.owner, "draft.txt"), "local commit\n");
  await checkoutGit(f.owner, ["add", "draft.txt"]);
  await checkoutGit(f.owner, [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "local",
  ]);
  expect(await syncOwnerCheckout(f.owner)).toMatchObject({
    outcome: "blocked",
    reason: expect.stringContaining("local commits"),
  });
  await checkoutGit(f.owner, ["switch", "-c", "owner-redesign"]);
  expect(await syncOwnerCheckout(f.owner)).toMatchObject({
    outcome: "blocked",
    reason: expect.stringContaining("owner-redesign"),
  });
  await checkoutGit(f.owner, ["remote", "set-url", "origin", join(f.root, "missing.git")]);
  expect((await syncOwnerCheckout(f.owner)).outcome).toBe("unavailable");
});
it("hire admission advances clean behind-only main/detached starts and refuses dirty or divergent work", async () => {
  const f = await fixture();
  expect((await verifyHireCheckout(f.owner)).outcome).toBe("fresh");
  const old = join(f.root, "old");
  await checkoutGit(f.owner, ["worktree", "add", "--detach", old, f.base]);
  const target = await f.advance();
  expect(await verifyHireCheckout(old)).toMatchObject({ outcome: "fresh", head: target, remoteMain: target });
  expect(await verifyHireCheckout(f.owner)).toMatchObject({ outcome: "fresh", head: target });
  const topic = join(f.root, "topic");
  await checkoutGit(f.owner, ["worktree", "add", "-b", "topic", topic, "origin/main"]);
  expect((await verifyHireCheckout(topic)).outcome).toBe("fresh");
  await writeFile(join(topic, "untracked.txt"), "unfinished\n");
  expect(await verifyHireCheckout(topic)).toMatchObject({
    outcome: "refused",
    reason: expect.stringContaining('"untracked.txt"'),
  });
  await mkdir(join(topic, ".tmp"));
  await writeFile(join(topic, ".tmp", "notes.txt"), "owner scratch\n");
  await writeFile(join(topic, "dynamodb-local-metadata.json"), "{}\n");
  const before = await checkoutGit(topic, ["status", "--porcelain=v1", "-z"]);
  const refusal = await verifyHireCheckout(topic);
  expect(refusal.reason).toContain('".tmp/"');
  expect(refusal.reason).toContain('"dynamodb-local-metadata.json"');
  expect(await checkoutGit(topic, ["status", "--porcelain=v1", "-z"])).toBe(before);
  expect(await readFile(join(topic, ".tmp", "notes.txt"), "utf8")).toBe("owner scratch\n");
  await checkoutGit(f.owner, ["remote", "set-url", "origin", join(f.root, "missing.git")]);
  expect((await verifyHireCheckout(f.owner)).outcome).toBe("refused");
  const nonGit = join(f.root, "non-git");
  await mkdir(nonGit);
  expect((await verifyHireCheckout(nonGit)).outcome).toBe("not-repository");
});
it("doctor/roster checkout facts distinguish cached refs, dirt, divergence and stale linked trees", async () => {
  const f = await fixture();
  const old = join(f.root, "old");
  await checkoutGit(f.owner, ["worktree", "add", "--detach", old, f.base]);
  const staleTopic = join(f.root, "stale-topic");
  await checkoutGit(f.owner, ["worktree", "add", "-b", "stale-topic", staleTopic, f.base]);
  await writeFile(join(staleTopic, "draft.txt"), "unmerged work\n");
  await checkoutGit(staleTopic, ["add", "draft.txt"]);
  await checkoutGit(staleTopic, [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "unmerged work",
  ]);
  await f.advance();
  // Read-only status cannot claim the origin advance before a successful fetch.
  expect(await inspectCheckout(f.owner)).toMatchObject({
    ahead: 0,
    behind: 0,
    staleWorktrees: 0,
    linkedWorktrees: 2,
  });
  await checkoutGit(f.owner, ["fetch", "origin", "main"]);
  const freshTopic = join(f.root, "fresh-topic");
  await checkoutGit(f.owner, ["worktree", "add", "-b", "fresh-topic", freshTopic, "origin/main"]);
  await writeFile(join(freshTopic, "draft.txt"), "fresh topic work\n");
  await checkoutGit(freshTopic, ["add", "draft.txt"]);
  await checkoutGit(freshTopic, [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fresh topic work",
  ]);
  await writeFile(join(f.owner, "draft.txt"), "dirty\n");
  const report = CheckoutReportSchema.parse({
    observedAt: new Date().toISOString(),
    refFreshness: "cached-origin/main",
    checkouts: [await inspectCheckout(f.owner)],
  });
  expect(report.checkouts[0]).toMatchObject({
    path: f.owner,
    ahead: 0,
    behind: 1,
    dirty: true,
    staleWorktrees: 2,
    linkedWorktrees: 3,
  });
  expect((await checkoutGit(f.owner, ["rev-parse", "HEAD"])).trim()).toBe(f.base);
});

it("finds linked worktrees with unlanded commits or uncommitted files by content, and nothing in landed or non-Git trees", async () => {
  const f = await fixture();
  const commit = (path: string, file: string, text: string) =>
    writeFile(join(path, file), text)
      .then(() => checkoutGit(path, ["add", file]))
      .then(() =>
        checkoutGit(path, [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          file,
        ]),
      );
  const trees: string[] = [];
  // Sequential: concurrent `worktree add` races on the shared config lock.
  for (const name of ["unlanded", "dirty", "rebased", "clean"]) {
    await checkoutGit(f.owner, [
      "worktree",
      "add",
      "--no-track",
      "-b",
      name,
      join(f.root, name),
      "origin/main",
    ]);
    trees.push(join(f.root, name));
  }
  const [unlanded, dirty, rebased, clean] = trees;
  await commit(unlanded!, "unlanded.txt", "only here\n");
  await writeFile(join(dirty!, "notes.txt"), "uncommitted\n");
  await commit(rebased!, "rebased.txt", "landed elsewhere\n");
  // The same patch reaches main as a different commit on top of other work.
  await f.advance();
  await commit(f.writer, "rebased.txt", "landed elsewhere\n");
  await checkoutGit(f.writer, ["push", "origin", "main"]);
  await checkoutGit(f.owner, ["fetch", "origin"]);
  expect(await reconcileWorktree(rebased!)).toMatchObject({ state: "reconciled", unlandedCommits: 0 });
  expect(await reconcileWorktree(clean!)).toMatchObject({ state: "reconciled" });
  expect(await reconcileWorktree(join(f.root, "missing"))).toBeUndefined();
  const found = await unreconciledLinkedWorktrees(f.owner);
  expect(
    found.map(({ path, state, branch, unlandedCommits, dirtyFiles }) => ({
      path,
      state,
      branch,
      unlandedCommits,
      dirtyFiles,
    })),
  ).toEqual([
    { path: dirty, state: "unreconciled", branch: "dirty", unlandedCommits: 0, dirtyFiles: 1 },
    { path: unlanded, state: "unreconciled", branch: "unlanded", unlandedCommits: 1, dirtyFiles: 0 },
  ]);
  expect(found.every((entry) => entry.lastActivityAt !== undefined)).toBe(true);
  expect(await unreconciledLinkedWorktrees(f.owner, (path) => path === unlanded)).toHaveLength(1);
  // The doctor contract carries them with owner and age.
  const status = await inspectCheckout(f.owner);
  expect(
    CheckoutReportSchema.parse({
      observedAt: new Date().toISOString(),
      refFreshness: "cached-origin/main",
      checkouts: [
        { ...status, unreconciled: found.map((entry) => ({ ...entry, owner: "Pip", ageSeconds: 5 })) },
      ],
    }).checkouts[0]!.unreconciled,
  ).toHaveLength(2);
});

it("behind hire preserves live, divergent and ignored-collision work and advances a clean topic", async () => {
  const f = await fixture();
  const live = join(f.root, "live");
  const collision = join(f.root, "collision");
  const divergent = join(f.root, "divergent");
  const topic = join(f.root, "old-topic");
  for (const path of [live, collision, divergent])
    await checkoutGit(f.owner, ["worktree", "add", "--detach", path, f.base]);
  await checkoutGit(f.owner, ["worktree", "add", "-b", "old-topic", topic, f.base]);
  await writeFile(join(collision, "ignored.txt"), "private notes\n");
  await writeFile(join(divergent, "draft.txt"), "local commit\n");
  await checkoutGit(divergent, ["add", "draft.txt"]);
  await checkoutGit(divergent, [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "local work",
  ]);
  const localHead = (await checkoutGit(divergent, ["rev-parse", "HEAD"])).trim();
  await f.advance("ignored.txt");
  expect(
    await verifyHireCheckout(live, async () => {
      throw Error("Live pane owns checkout");
    }),
  ).toMatchObject({ outcome: "refused", reason: expect.stringContaining("Live pane") });
  expect((await verifyHireCheckout(collision)).outcome).toBe("refused");
  expect((await verifyHireCheckout(divergent)).outcome).toBe("refused");
  expect((await verifyHireCheckout(topic)).outcome).toBe("fresh");
  expect((await checkoutGit(live, ["rev-parse", "HEAD"])).trim()).toBe(f.base);
  expect((await checkoutGit(collision, ["rev-parse", "HEAD"])).trim()).toBe(f.base);
  expect((await checkoutGit(divergent, ["rev-parse", "HEAD"])).trim()).toBe(localHead);
  expect(await readFile(join(collision, "ignored.txt"), "utf8")).toBe("private notes\n");
  expect(await checkoutGit(collision, ["stash", "list"])).toBe("");
});
