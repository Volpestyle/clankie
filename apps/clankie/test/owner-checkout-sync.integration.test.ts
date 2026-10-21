import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { checkoutGit, type CheckoutSyncResult } from "@clankie/settings";
import { ownerCheckoutSyncReport, startOwnerCheckoutSync } from "../src/owner-checkout-sync.ts";
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

it("reports a checkout parked on a branch to the log alone, never the owner's chat (VUH-2586)", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-auto-sync-report-")));
  let observer: ReturnType<typeof startOwnerCheckoutSync> | undefined;
  try {
    const origin = join(root, "origin.git"),
      owner = join(root, "owner"),
      worker = join(root, "worker");
    await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
    await exec("git", ["clone", origin, owner]);
    for (const path of [owner]) {
      await checkoutGit(path, ["config", "user.name", "Fixture"]);
      await checkoutGit(path, ["config", "user.email", "fixture@example.invalid"]);
    }
    const commit = async (path: string, message: string) => {
      await writeFile(join(path, "incoming.txt"), message);
      await checkoutGit(path, ["add", "incoming.txt"]);
      await checkoutGit(path, [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        message.trim(),
      ]);
    };
    await commit(owner, "base\n");
    await checkoutGit(owner, ["push", "origin", "main"]);
    await checkoutGit(owner, ["worktree", "add", "--detach", worker, "HEAD"]);
    // As James's was: the owner checkout sits on a design branch with evidence files beside it.
    await checkoutGit(owner, ["switch", "-c", "sable/vuh-2450-prologue-coop-design"]);
    await writeFile(join(owner, "evidence.png"), "untracked\n");
    const log: { level: "info" | "warn"; fields: Record<string, unknown>; message: string }[] = [];
    const logger = {
      info: (fields: object, message: string) =>
        void log.push({ level: "info", fields: fields as Record<string, unknown>, message }),
      warn: (fields: object, message: string) =>
        void log.push({ level: "warn", fields: fields as Record<string, unknown>, message }),
    };
    const report = ownerCheckoutSyncReport(
      logger as unknown as Parameters<typeof ownerCheckoutSyncReport>[0],
    );
    // The service's reporter takes a logger and nothing else: it has no way to write a chat entry.
    expect(ownerCheckoutSyncReport.length).toBe(1);
    observer = startOwnerCheckoutSync({
      repositories: async () => [owner],
      report,
      intervalMs: 10,
      fetchIntervalMs: 60_000,
    });
    await observer.check();
    // Startup catch-up already finds it parked; each later landing logs it once more.
    expect(log).toHaveLength(1);
    await commit(worker, "landed\n");
    await checkoutGit(worker, ["push", "origin", "HEAD:main"]);
    await expect.poll(() => log.length, { timeout: 5000 }).toBe(2);
    await observer.check();
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({
      level: "warn",
      message: "Owner checkout sync needs attention",
      fields: { event: "checkouts.auto_sync_blocked", path: owner, outcome: "blocked" },
    });
    expect(String(log[1]!.fields.reason)).toContain("sable/vuh-2450-prologue-coop-design");
    // The owner's branch and files are untouched.
    expect((await checkoutGit(owner, ["branch", "--show-current"])).trim()).toBe(
      "sable/vuh-2450-prologue-coop-design",
    );
    expect(await readFile(join(owner, "evidence.png"), "utf8")).toBe("untracked\n");
  } finally {
    await observer?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
