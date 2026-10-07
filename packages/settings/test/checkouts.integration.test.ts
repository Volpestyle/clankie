import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { CheckoutReportSchema } from "@clankie/protocol";
import { checkoutGit, inspectCheckout, syncOwnerCheckout, verifyHireCheckout } from "../src/checkouts.ts";
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
it("hire admission fetches actual main, refuses stale or dirty starts and accepts current topic branches", async () => {
  const f = await fixture();
  expect((await verifyHireCheckout(f.owner)).outcome).toBe("fresh");
  const old = join(f.root, "old");
  await checkoutGit(f.owner, ["worktree", "add", "--detach", old, f.base]);
  const target = await f.advance();
  expect(await verifyHireCheckout(old)).toMatchObject({ outcome: "refused", remoteMain: target });
  expect((await syncOwnerCheckout(f.owner)).outcome).toBe("updated");
  const topic = join(f.root, "topic");
  await checkoutGit(f.owner, ["worktree", "add", "-b", "topic", topic, "origin/main"]);
  expect((await verifyHireCheckout(topic)).outcome).toBe("fresh");
  await writeFile(join(topic, "untracked.txt"), "unfinished\n");
  expect(await verifyHireCheckout(topic)).toMatchObject({
    outcome: "refused",
    reason: expect.stringContaining("dirty"),
  });
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
