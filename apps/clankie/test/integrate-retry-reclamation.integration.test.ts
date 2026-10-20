import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { aroundEach, beforeAll, expect, it } from "vitest";
import type { IntegrationBatch } from "@clankie/protocol/integrate";
import { IntegrationQueue } from "../src/integrate.ts";
import { durableJson, withDirectoryLock } from "../src/deploy-holds.ts";
import { fixtureWork, withFixtureWork } from "../../../scripts/testing/fixture-work.ts";

const execute = promisify(execFile);
aroundEach(withFixtureWork);
beforeAll(async () => {
  if (process.platform === "darwin")
    await execute(process.execPath, [join(import.meta.dirname, "../../../scripts/build-fleet-proof.mjs")]);
});

it
  .runIf(process.platform === "darwin")
  .each([
    "queued lineage",
    "recoverable interrupted receipt before its retry claim",
    "interruptionRetry source until the request finishes",
    "shared failure before retry admission",
    "reused gate while its candidate is active",
  ] as const)(
  "busy tree reclamation fences %s",
  async (scenario) => {
    const work = fixtureWork();
    const root = await realpath(await mkdtemp(join(tmpdir(), "integration-retry-retain-")));
    const source = join(root, "source");
    const directory = join(root, "integration");
    const git = async (cwd: string, ...args: string[]) =>
      (await execute("git", ["-C", cwd, ...args], { signal: work.signal })).stdout.trim();
    const queue = new IntegrationQueue({ directory, core: source });
    try {
      await mkdir(source);
      await git(source, "init", "-b", "main");
      await git(source, "config", "user.name", "Fixture");
      await git(source, "config", "user.email", "fixture@example.invalid");
      await writeFile(join(source, "feature"), "approved objects");
      await git(source, "add", "feature");
      await git(source, "commit", "-m", "approved");
      const head = await git(source, "rev-parse", "HEAD");
      const batch = (id: string, state: IntegrationBatch["state"]): IntegrationBatch => ({
        schemaVersion: 1,
        id,
        state,
        request: { action: "run", id, core: [head], push: true },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        evidence: join(directory, "batches", id, "record.json"),
        repos: [],
      });
      const terminal = async (state: IntegrationBatch["state"]) => {
        const record = batch(randomUUID(), state);
        const home = join(directory, "batches", record.id);
        const repository = join(home, "repositories", "core");
        const tree = join(home, "worktrees", "clankie");
        await mkdir(join(home, "repositories"), { recursive: true });
        await mkdir(join(home, "worktrees"));
        await git(home, "clone", "--no-hardlinks", "--no-checkout", source, repository);
        await git(repository, "worktree", "add", "--detach", tree, head);
        await mkdir(join(tree, "node_modules"));
        await writeFile(join(tree, "node_modules", "bulk"), Buffer.alloc(1024 * 1024, 1));
        const log = join(home, "core-gate.log");
        await writeFile(log, "retained gate evidence");
        record.repos = [
          { name: "core", source, origin: source, base: head, head, directory: tree, commits: [] },
        ];
        await durableJson(record.evidence, record);
        return { record, tree, repository, log };
      };
      const protectedSource = await terminal(
        scenario.startsWith("recoverable") || scenario.startsWith("interruptionRetry")
          ? "interrupted"
          : "failed",
      );
      const disposable = await terminal("failed");
      let receipt = batch(randomUUID(), "queued");
      if (scenario === "queued lineage") {
        receipt.attempts = [protectedSource.record.id];
      } else if (scenario === "recoverable interrupted receipt before its retry claim") {
        receipt.state = "interrupted";
        receipt.restartRecovery = true;
        receipt.batchId = protectedSource.record.id;
      } else if (scenario === "interruptionRetry source until the request finishes") {
        receipt = protectedSource.record;
        receipt.state = "queued";
        receipt.interruptionRetry = { batchId: receipt.id, at: new Date().toISOString() };
        receipt.restartRecovery = true;
      } else if (scenario === "reused gate while its candidate is active") {
        const candidate = await terminal("gating");
        receipt = candidate.record;
        receipt.repos[0]!.gateReuse = {
          batchId: protectedSource.record.id,
          tree: await git(source, "rev-parse", `${head}^{tree}`),
          coreHead: head,
        };
      } else {
        receipt.batchId = protectedSource.record.id;
        const withdrawn = batch(randomUUID(), "cancelled");
        await durableJson(withdrawn.evidence, withdrawn);
        protectedSource.record.members = [receipt.request, withdrawn.request];
        await durableJson(protectedSource.record.evidence, protectedSource.record);
      }
      await durableJson(receipt.evidence, receipt);
      await withDirectoryLock(join(directory, "queue.lock"), async () => {
        const first = await queue.reclaimWorktrees();
        expect(first.reclaimed, JSON.stringify(first.kept)).toContain(disposable.tree);
        expect(existsSync(protectedSource.tree)).toBe(true);
        expect(first.kept).toContainEqual({ id: protectedSource.record.id, reason: "retry_source" });
        const reread = JSON.parse(await readFile(receipt.evidence, "utf8"));
        expect(reread).toEqual(receipt);
        // A completed/exhausted request releases its old source despite retained lineage.
        if (scenario === "interruptionRetry source until the request finishes") {
          const completed = await terminal("pushed");
          receipt.batchId = completed.record.id;
          // Producers retain the original queued receipt; the shared result is final.
        } else {
          receipt.state = "cancelled";
          receipt.restartRecovery = false;
        }
        await durableJson(receipt.evidence, receipt);
        const second = await queue.reclaimWorktrees();
        expect(second.reclaimed, JSON.stringify(second.kept)).toContain(protectedSource.tree);
        expect(existsSync(protectedSource.tree)).toBe(false);
        expect(await readFile(protectedSource.log, "utf8")).toBe("retained gate evidence");
        expect(await git(protectedSource.repository, "rev-parse", "refs/clankie/retained/core")).toBe(head);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
