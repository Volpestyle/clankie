import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { aroundEach, beforeAll, expect, it } from "vitest";
import { IntegrationRunSchema } from "@clankie/protocol/integrate";
import { IntegrationQueue } from "../src/integrate.ts";
import { durableJson } from "../src/deploy-holds.ts";
import { withReclamationWindow } from "../src/integrate-reclamation.ts";
import { fixtureWork, withFixtureWork } from "../../../scripts/testing/fixture-work.ts";
import { fixtureGovernor } from "../../../scripts/testing/fixture-governor.ts";

const execute = promisify(execFile);
aroundEach(withFixtureWork);
beforeAll(async () => {
  if (process.platform === "darwin")
    await execute(process.execPath, [join(import.meta.dirname, "../../../scripts/build-fleet-proof.mjs")]);
});

it.runIf(process.platform === "darwin")(
  "reclaims copied download stores during a real gate, preserves evidence and trees, and both live and held batches land",
  async () => {
    const work = fixtureWork();
    const root = await realpath(await mkdtemp(join(tmpdir(), "integration-reclaim-")));
    const source = join(root, "source");
    const origin = join(root, "origin.git");
    const directory = join(root, "integration");
    const git = async (cwd: string, ...args: string[]) =>
      (await execute("git", ["-C", cwd, ...args], { signal: work.signal })).stdout.trim();
    const governor = fixtureGovernor(join(root, "resources"), work.signal);
    const queue = new IntegrationQueue({
      review: async (_directory, patchId) => ({
        schemaVersion: 1,
        required: false,
        patchId,
        status: "not_required",
        landable: true,
      }),
      directory,
      core: source,
      governor: () => governor,
    });
    // A separate queue instance proves the sweep does not depend on in-memory running/retry sets.
    const observer = new IntegrationQueue({
      review: async (_directory, patchId) => ({
        schemaVersion: 1,
        required: false,
        patchId,
        status: "not_required",
        landable: true,
      }),
      directory,
      core: source,
      governor: () => governor,
    });
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
      await writeFile(
        join(source, "gate.mjs"),
        `
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
writeFileSync(${JSON.stringify(join(root, "entered"))}, 'gating');
while (existsSync(${JSON.stringify(join(root, "block"))}) && !existsSync(${JSON.stringify(join(root, "release"))})) await setTimeout(50);
console.log('completed real gate');
`,
      );
      await execute("pnpm", ["install", "--lockfile-only"], { cwd: source, signal: work.signal });
      await writeFile(join(source, ".gitignore"), "node_modules/\n");
      await git(source, "add", "package.json", "pnpm-lock.yaml", "gate.mjs", ".gitignore");
      await git(source, "commit", "-m", "base");
      await git(source, "push", "origin", "HEAD:main");
      const head = await git(source, "rev-parse", "HEAD");
      const historicalId = randomUUID();
      await queue.start(IntegrationRunSchema.parse({ action: "run", id: historicalId, core: [head] }), guard);
      await queue.wait();
      const historical = await queue.status(historicalId);
      if (historical.state !== "passed") {
        console.error(JSON.stringify(historical, null, 2));
        for (const repo of historical.repos)
          for (const log of [repo.install?.log, repo.gate?.log])
            if (log) console.error(log, await readFile(log, "utf8"));
      }
      expect(historical.state).toBe("passed");
      // This historical failed record predates the busy queue owner.
      historical.state = "failed";
      await durableJson(historical.evidence, historical);
      const tree = historical.repos[0]!.directory;
      await mkdir(join(tree, "node_modules"), { recursive: true });
      await writeFile(join(tree, "node_modules", "bulk"), Buffer.alloc(8 * 1024 * 1024, 1));
      const historicalStore = join(directory, "batches", historicalId, "isolation", "core", "pnpm-store");
      await mkdir(historicalStore, { recursive: true });
      await writeFile(join(historicalStore, "copied-packages"), Buffer.alloc(8 * 1024 * 1024, 1));
      const log = await readFile(historical.repos[0]!.gate!.log);
      const receipts = historical.request;
      const heldId = randomUUID();
      await queue.start(IntegrationRunSchema.parse({ action: "run", id: heldId, core: [head] }), guard);
      await queue.wait();
      const held = await queue.status(heldId);
      expect(held.state).toBe("passed");
      const heldStore = join(directory, "batches", heldId, "isolation", "core", "pnpm-store");
      await mkdir(heldStore, { recursive: true });
      await writeFile(join(heldStore, "copied-packages"), Buffer.alloc(4 * 1024 * 1024, 1));
      await rm(join(root, "entered"));
      await writeFile(join(root, "block"), "hold gate");
      const liveId = randomUUID();
      await queue.start(
        IntegrationRunSchema.parse({ action: "run", id: liveId, core: [head], push: true }),
        guard,
      );
      await expect.poll(() => existsSync(join(root, "entered")), { timeout: 30_000 }).toBe(true);
      expect((await queue.status(liveId)).state).toBe("gating");
      const live = await queue.status(liveId);
      // Its trees are still a queued retry source; copied stores are independent.
      const retryId = randomUUID();
      await durableJson(join(directory, "batches", retryId, "record.json"), {
        ...historical,
        id: retryId,
        request: { ...receipts, id: retryId },
        state: "queued",
        restartRecovery: false,
        repos: [],
        evidence: join(directory, "batches", retryId, "record.json"),
        isolation: { rootBatchId: historicalId },
      });
      const repository = join(directory, "batches", historicalId, "repositories", "core");
      await git(repository, "update-ref", "refs/clankie/retained/core", head);
      const recordBytes = await readFile(historical.evidence);
      const reclaim = await observer.reclaimWorktrees();
      expect(reclaim.reclaimed, JSON.stringify(reclaim.kept)).toContain(historicalStore);
      expect(reclaim.freedBytes).toBeGreaterThan(8 * 1024 * 1024);
      expect(existsSync(tree)).toBe(true);
      expect(existsSync(join(tree, "node_modules", "bulk"))).toBe(true);
      expect(existsSync(historicalStore)).toBe(false);
      expect(await readFile(historical.repos[0]!.gate!.log)).toEqual(log);
      const retained = await observer.status(historicalId);
      expect(retained.request).toEqual(receipts);
      expect(await readFile(historical.evidence)).toEqual(recordBytes);
      expect(await git(repository, "rev-parse", "refs/clankie/retained/core")).toBe(head);
      expect(existsSync(heldStore)).toBe(false);
      expect(existsSync(held.repos[0]!.directory)).toBe(true);
      expect((await observer.status(heldId)).state).toBe("passed");
      expect(existsSync(live.repos[0]!.directory)).toBe(true);
      expect((await queue.status(liveId)).state).toBe("gating");
      await writeFile(join(root, "release"), "finish gate");
      await queue.wait();
      expect((await queue.status(liveId)).state).toBe("pushed");
      expect(await git(root, "--git-dir", origin, "rev-parse", "main")).toBe(head);
      expect((await queue.land(heldId, guard)).state).toBe("pushed");
      console.log("Concurrent reclamation proof", { historicalId, liveId, freedBytes: reclaim.freedBytes });
    } finally {
      await writeFile(join(root, "release"), "release owned gate");
      await queue.wait();
      await governor.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);

it("refuses reclamation with an unrecorded queue owner without entering the sweep", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "integration-owner-")));
  try {
    await mkdir(join(root, "queue.lock"));
    let entered = false;
    await expect(
      withReclamationWindow(root, async () => {
        entered = true;
      }),
    ).rejects.toThrow();
    expect(entered).toBe(false);
    expect(existsSync(join(root, "queue.lock"))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
