import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { checkoutGit, type CheckoutSyncResult } from "@clankie/settings";
import { startOwnerCheckoutSync } from "../src/owner-checkout-sync.ts";
const exec = promisify(execFile);

it("observes repeated direct worktree pushes, preserves owner edits and warns on blockers without duplicate notices", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-auto-sync-")));
  let observer: ReturnType<typeof startOwnerCheckoutSync> | undefined;
  try {
    const origin = join(root, "origin.git"),
      owner = join(root, "owner"),
      worker = join(root, "worker");
    await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
    await exec("git", ["clone", origin, owner]);
    await checkoutGit(owner, ["config", "user.name", "Fixture"]);
    await checkoutGit(owner, ["config", "user.email", "fixture@example.invalid"]);
    const commit = async (path: string, file: string, contents: string) => {
      await writeFile(join(path, file), contents);
      await checkoutGit(path, ["add", file]);
      await checkoutGit(path, [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        contents.trim(),
      ]);
      return (await checkoutGit(path, ["rev-parse", "HEAD"])).trim();
    };
    await commit(owner, "incoming.txt", "base\n");
    await checkoutGit(owner, ["push", "origin", "main"]);
    await checkoutGit(owner, ["worktree", "add", "--detach", worker, "HEAD"]);
    const reports: CheckoutSyncResult[] = [];
    observer = startOwnerCheckoutSync({
      repositories: async () => [owner, worker],
      report: (result) => reports.push(result),
      intervalMs: 10,
      fetchIntervalMs: 60_000,
    });
    await observer.check();
    await writeFile(join(owner, "notes.txt"), "owner scratch\n");
    for (const text of ["first\n", "second\n"]) {
      const head = await commit(worker, "incoming.txt", text);
      await checkoutGit(worker, ["push", "origin", "HEAD:main"]);
      await expect
        .poll(async () => (await checkoutGit(owner, ["rev-parse", "HEAD"])).trim(), { timeout: 5000 })
        .toBe(head);
      expect(await readFile(join(owner, "notes.txt"), "utf8")).toBe("owner scratch\n");
    }
    await writeFile(join(owner, "incoming.txt"), "owner draft\n");
    const before = (await checkoutGit(owner, ["rev-parse", "HEAD"])).trim();
    await commit(worker, "incoming.txt", "third\n");
    await checkoutGit(worker, ["push", "origin", "HEAD:main"]);
    await expect
      .poll(() => reports.filter((result) => result.outcome === "blocked").length, { timeout: 5000 })
      .toBe(1);
    await observer.check();
    expect(reports.filter((result) => result.outcome === "blocked")).toHaveLength(1);
    expect(reports.find((result) => result.outcome === "blocked")).toMatchObject({
      blockers: [{ path: "incoming.txt", ageSeconds: expect.any(Number) }],
    });
    expect((await checkoutGit(owner, ["rev-parse", "HEAD"])).trim()).toBe(before);
    expect(await readFile(join(owner, "incoming.txt"), "utf8")).toBe("owner draft\n");
    await observer.close();
    expect(reports.filter((result) => result.outcome === "updated")).toHaveLength(2);
    // A separate clone's push does not update the owner's cached remote ref.
    const other = join(root, "other");
    await exec("git", ["clone", origin, other]);
    await checkoutGit(other, ["config", "user.name", "Fixture"]);
    await checkoutGit(other, ["config", "user.email", "fixture@example.invalid"]);
    const head = await commit(other, "new.txt", "separate clone\n");
    await checkoutGit(other, ["push", "origin", "main"]);
    observer = startOwnerCheckoutSync({
      repositories: async () => [owner],
      report: (result) => reports.push(result),
      intervalMs: 10,
      fetchIntervalMs: 0,
    });
    await observer.check();
    expect((await checkoutGit(owner, ["rev-parse", "origin/main"])).trim()).toBe(head);
    expect(reports.at(-1)?.outcome).toBe("blocked");
  } finally {
    await observer?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
