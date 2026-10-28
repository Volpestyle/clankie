import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { aroundEach, beforeAll, expect, it } from "vitest";
import { IntegrationRunSchema } from "@clankie/protocol/integrate";
import { IntegrationQueue } from "../src/integrate.ts";
import { durableJson } from "../src/deploy-holds.ts";
import {
  INTEGRATION_PASS_EXPIRY_MS,
  INTEGRATION_REPOSITORY_RETENTION_MS,
} from "../src/integrate-reclamation.ts";
import { fixtureWork, withFixtureWork } from "../../../scripts/testing/fixture-work.ts";
import { fixtureGovernor } from "../../../scripts/testing/fixture-governor.ts";

const execute = promisify(execFile);
aroundEach(withFixtureWork);
beforeAll(async () => {
  if (process.platform === "darwin")
    await execute(process.execPath, [join(import.meta.dirname, "../../../scripts/build-fleet-proof.mjs")]);
});

it.runIf(process.platform === "darwin")(
  "the idle sweep drops expired clones, keeps every clone push, retry or revert still reads, and revert survives",
  async () => {
    const work = fixtureWork();
    const root = await realpath(await mkdtemp(join(tmpdir(), "integration-retention-")));
    const source = join(root, "source");
    const origin = join(root, "origin.git");
    const directory = join(root, "integration");
    const git = async (cwd: string, ...args: string[]) =>
      (await execute("git", ["-C", cwd, ...args], { signal: work.signal })).stdout.trim();
    const governor = fixtureGovernor(join(root, "resources"), work.signal);
    const options = {
      review: async (_directory: string, patchId: string) => ({
        schemaVersion: 1 as const,
        required: false,
        patchId,
        status: "not_required" as const,
        landable: true,
      }),
      directory,
      core: source,
      governor: () => governor,
    };
    const queue = new IntegrationQueue(options);
    // Sweeps run from a second instance: retention must not depend on in-memory queue state.
    const observer = new IntegrationQueue(options);
    const guard = async () => work.signal.throwIfAborted();
    try {
      await mkdir(source);
      await git(root, "init", "--bare", origin);
      await git(source, "init", "-b", "main");
      await git(source, "config", "user.name", "Fixture");
      await git(source, "config", "user.email", "fixture@example.invalid");
      await git(source, "remote", "add", "origin", origin);
      await writeFile(
        join(source, "package.json"),
        JSON.stringify({
          private: true,
          packageManager: "pnpm@11.11.0",
          scripts: { check: "node gate.mjs" },
        }),
      );
      // A request that adds `fail` fails its real gate.
      await writeFile(
        join(source, "gate.mjs"),
        "import { existsSync } from 'node:fs';\nprocess.exit(existsSync('fail') ? 1 : 0);\n",
      );
      await execute("pnpm", ["install", "--lockfile-only"], { cwd: source, signal: work.signal });
      await writeFile(join(source, ".gitignore"), "node_modules/\n");
      await git(source, "add", "package.json", "pnpm-lock.yaml", "gate.mjs", ".gitignore");
      await git(source, "commit", "-m", "base");
      await git(source, "push", "origin", "HEAD:main");
      const base = await git(source, "rev-parse", "HEAD");
      // Each request is one commit on its own base, so none lists another's ancestors.
      const change = async (file: string) => {
        await git(source, "checkout", "-q", "--detach", base);
        await writeFile(join(source, file), file);
        await git(source, "add", file);
        await git(source, "commit", "-q", "-m", file);
        const commit = await git(source, "rev-parse", "HEAD");
        await git(source, "checkout", "-q", "main");
        return commit;
      };
      const run = async (commit: string, push: boolean) => {
        const id = randomUUID();
        await queue.start(IntegrationRunSchema.parse({ action: "run", id, core: [commit], push }), guard);
        await queue.wait();
        return queue.status(id);
      };
      const clone = (id: string) => join(directory, "batches", id, "repositories", "core");

      const pushed = await run(await change("pushed"), true);
      expect(pushed.state, pushed.error).toBe("pushed");
      // Two more pushed clones that a tree still depends on: one whose scratch tree lost its
      // registration so the sweep cannot remove it, one with a locked tree registered elsewhere.
      const lost = await run(await change("lost"), true);
      const locked = await run(await change("locked"), true);
      expect([lost.state, locked.state]).toEqual(["pushed", "pushed"]);
      const scratch = lost.repos[0]!.directory;
      await git(clone(lost.id), "worktree", "add", "--detach", scratch, lost.repos[0]!.head);
      await rm(join(clone(lost.id), ".git", "worktrees", basename(scratch)), { recursive: true });
      const outside = join(root, "outside-locked");
      await git(clone(locked.id), "worktree", "add", "--detach", outside, locked.repos[0]!.head);
      await git(clone(locked.id), "worktree", "lock", outside);
      const passed = await run(await change("passed"), false);
      expect(passed.state, passed.error).toBe("passed");
      const stale = await run(await change("stale"), false);
      expect(stale.state, stale.error).toBe("passed");
      const failed = await run(await change("fail"), false);
      expect(failed.state).toBe("failed");
      const retried = await run(await change("fail"), false);
      expect(retried.state).toBe("failed");
      // A durable retry receipt whose isolation root is the failed attempt (ADR 0240).
      const retryId = randomUUID();
      await durableJson(join(directory, "batches", retryId, "record.json"), {
        ...retried,
        id: retryId,
        request: { ...retried.request, id: retryId },
        state: "queued",
        restartRecovery: false,
        repos: [],
        evidence: join(directory, "batches", retryId, "record.json"),
        isolation: { rootBatchId: retried.id },
      });
      for (const batch of [pushed, failed, retried]) expect(existsSync(clone(batch.id))).toBe(true);
      const logs = [pushed, failed].map((batch) => batch.repos[0]!.gate!.log);

      // Fresh: only the pushed clone goes; its head is on origin/main.
      const first = await observer.reclaimWorktrees();
      expect(first.reclaimed, JSON.stringify(first.kept)).toEqual([clone(pushed.id)]);
      expect(first.freedBytes).toBeGreaterThan(0);
      expect(first.kept).toContainEqual({ id: failed.id, reason: "repository_retention" });
      expect(first.kept).toContainEqual({ id: lost.id, reason: "repository_has_worktrees" });
      expect(first.kept).toContainEqual({ id: locked.id, reason: "repository_has_worktrees" });
      for (const batch of [lost, locked]) expect(existsSync(clone(batch.id))).toBe(true);
      expect(existsSync(scratch)).toBe(true);
      expect(await git(outside, "rev-parse", "HEAD")).toBe(locked.repos[0]!.head);
      expect(existsSync(clone(failed.id))).toBe(true);

      // Past the bound: the plain failure goes; the retry source and the pass stay.
      const later = Date.now() + INTEGRATION_REPOSITORY_RETENTION_MS + 60_000;
      const second = await observer.reclaimWorktrees(later);
      expect(second.reclaimed, JSON.stringify(second.kept)).toEqual([clone(failed.id)]);
      expect(second.kept).toContainEqual({ id: retried.id, reason: "retry_source" });
      expect(existsSync(clone(retried.id))).toBe(true);
      for (const batch of [passed, stale]) {
        expect(existsSync(clone(batch.id))).toBe(true);
        expect(existsSync(batch.repos[0]!.directory)).toBe(true);
      }

      // Records and logs stay, and say what was reclaimed.
      for (const log of logs) expect(existsSync(log)).toBe(true);
      const record = await observer.status(failed.id);
      expect(record.state).toBe("failed");
      expect(record.repositoryReclamation).toEqual([
        { path: clone(failed.id), freedBytes: expect.any(Number), at: new Date(later).toISOString() },
      ]);
      expect(existsSync(join(directory, "batches", failed.id, "repositories"))).toBe(false);

      // The kept pass still lands.
      expect((await queue.land(passed.id, guard)).state).toBe("pushed");
      const landed = await git(root, "--git-dir", origin, "rev-parse", "main");

      // An unlanded pass expires after 7 days: its trees and clone go, and push refuses.
      const expiry = Date.now() + INTEGRATION_PASS_EXPIRY_MS + 60_000;
      const third = await observer.reclaimWorktrees(expiry);
      expect(third.reclaimed, JSON.stringify(third.kept)).toEqual(
        expect.arrayContaining([stale.repos[0]!.directory, clone(stale.id)]),
      );
      expect(third.reclaimed).not.toContain(clone(retried.id));
      expect(existsSync(clone(retried.id))).toBe(true);
      const expired = await observer.status(stale.id);
      expect(expired.expired).toEqual({ at: new Date(expiry).toISOString() });
      expect(existsSync(join(directory, "batches", stale.id, "record.json"))).toBe(true);
      expect(existsSync(stale.repos[0]!.gate!.log)).toBe(true);
      await expect(queue.land(stale.id, guard)).rejects.toThrow("expired after 7 days");
      const expiredRevert = randomUUID();
      await queue.start(
        IntegrationRunSchema.parse({ action: "run", id: expiredRevert, restore: stale.id, push: true }),
        guard,
      );
      await queue.wait();
      const refused = await queue.status(expiredRevert);
      expect(refused.state).toBe("failed");
      expect(refused.error).toContain("expired after 7 days");

      // Reverting to the reclaimed pushed batch restores its tree from origin's history.
      const revertId = randomUUID();
      await queue.start(
        IntegrationRunSchema.parse({ action: "run", id: revertId, restore: pushed.id, push: true }),
        guard,
      );
      await queue.wait();
      const reverted = await queue.status(revertId);
      expect(reverted.state, reverted.error).toBe("pushed");
      const head = await git(root, "--git-dir", origin, "rev-parse", "main");
      expect(await git(root, "--git-dir", origin, "rev-parse", `${head}^`)).toBe(landed);
      expect(await git(root, "--git-dir", origin, "rev-parse", `${head}^{tree}`)).toBe(
        await git(root, "--git-dir", origin, "rev-parse", `${pushed.repos[0]!.head}^{tree}`),
      );
    } finally {
      await queue.wait();
      await governor.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
