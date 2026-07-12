import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WorktreeManager } from "../src/worktrees.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync("git", args, { cwd })).stdout;
}

async function initRepo(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), "clankie-worktree-repo-"));
  await git(repoPath, ["init", "-b", "main"]);
  await git(repoPath, ["config", "user.email", "test@clankie.local"]);
  await git(repoPath, ["config", "user.name", "Clankie Test"]);
  await writeFile(join(repoPath, "README.md"), "# fixture\n", "utf8");
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "-m", "initial"]);
  return repoPath;
}

async function makeManager(
  overrides: Partial<ConstructorParameters<typeof WorktreeManager>[0]> = {},
): Promise<{ manager: WorktreeManager; repoPath: string; rootDir: string }> {
  const repoPath = overrides.repoPath ?? (await initRepo());
  const rootDir = overrides.rootDir ?? (await mkdtemp(join(tmpdir(), "clankie-worktree-state-")));
  return { manager: new WorktreeManager({ repoPath, rootDir, ...overrides }), repoPath, rootDir };
}

const holder = (workerRunId: string) => ({ missionId: "m-1", taskId: "t-1", workerRunId });

describe("WorktreeManager", () => {
  it("never grants two write leases on the same path", async () => {
    const { manager } = await makeManager();
    const lease = await manager.create(holder("run-a"));
    await expect(manager.acquireWriteLease(lease.path, holder("run-b"))).rejects.toThrow(
      /already write-leased by worker run run-a/,
    );

    const shared = join(tmpdir(), "clankie-shared-scope");
    await manager.acquireWriteLease(shared, holder("run-c"));
    await expect(manager.acquireWriteLease(shared, holder("run-d"))).rejects.toThrow(
      /already write-leased by worker run run-c/,
    );
    // Distinct worktrees for the same task get distinct paths, so both may exist.
    const second = await manager.create(holder("run-e"));
    expect(second.path).not.toBe(lease.path);
  });

  it("removes unchanged worktrees and preserves dirty ones with evidence on release", async () => {
    const { manager, repoPath } = await makeManager();

    const clean = await manager.create(holder("run-clean"));
    expect(await manager.release(clean.id)).toMatchObject({ outcome: "removed" });
    expect((await git(repoPath, ["worktree", "list"])).includes(clean.path)).toBe(false);
    // The path is leasable again once released.
    await manager.acquireWriteLease(clean.path, holder("run-clean-2"));

    const dirty = await manager.create(holder("run-dirty"));
    await writeFile(join(dirty.path, "src.ts"), "export const x = 1;\n", "utf8");
    const released = await manager.release(dirty.id);
    expect(released.outcome).toBe("preserved");
    expect((await git(repoPath, ["worktree", "list"])).includes(dirty.path)).toBe(true);
    const evidence = JSON.parse(await readFile(released.evidencePath as string, "utf8")) as {
      status: string;
      lease: { workerRunId: string };
    };
    expect(evidence.status).toContain("src.ts");
    expect(evidence.lease.workerRunId).toBe("run-dirty");

    // Committed-beyond-base but clean status still counts as changed work.
    const committed = await manager.create(holder("run-committed"));
    await writeFile(join(committed.path, "feature.ts"), "export const y = 2;\n", "utf8");
    await git(committed.path, ["add", "."]);
    await git(committed.path, ["commit", "-m", "feature work"]);
    expect(await manager.release(committed.id)).toMatchObject({ outcome: "preserved" });
  });

  it("reclaims a crashed worker's worktrees safely on restart", async () => {
    const { manager, repoPath, rootDir } = await makeManager();
    const crashedClean = await manager.create(holder("run-crashed-clean"));
    const crashedDirty = await manager.create(holder("run-crashed-dirty"));
    await writeFile(join(crashedDirty.path, "wip.ts"), "// in flight\n", "utf8");
    // The runner "crashes" here: no release; a new runner process starts up.

    const survivor = new WorktreeManager({ repoPath, rootDir, isProcessAlive: () => false });
    const report = await survivor.reclaimOrphans();
    expect(report.removed.map((entry) => entry.leaseId)).toEqual([crashedClean.id]);
    expect(report.preserved.map((entry) => entry.leaseId)).toEqual([crashedDirty.id]);
    expect(report.live).toEqual([]);

    const worktrees = await git(repoPath, ["worktree", "list"]);
    expect(worktrees.includes(crashedClean.path)).toBe(false);
    expect(worktrees.includes(crashedDirty.path)).toBe(true);
    const evidencePath = report.preserved[0]?.evidencePath as string;
    expect(JSON.parse(await readFile(evidencePath, "utf8"))).toMatchObject({
      lease: { workerRunId: "run-crashed-dirty" },
    });
    expect(await survivor.listLeases()).toEqual([]);
  });

  it("atomically manifests and reacquires a preserved dirty mission candidate", async () => {
    const { manager, repoPath, rootDir } = await makeManager();
    const candidate = await manager.create(holder("run-candidate"));
    await manager.persistCandidate(candidate);
    await writeFile(join(candidate.path, "candidate.ts"), "export const retained = true;\n", "utf8");

    const restarted = new WorktreeManager({ repoPath, rootDir, isProcessAlive: () => false });
    expect((await restarted.reclaimOrphans()).preserved).toHaveLength(1);
    const recovered = await restarted.recoverCandidate("m-1", holder("run-verifier"));
    expect(recovered).toMatchObject({
      path: candidate.path,
      branch: candidate.branch,
      baseCommit: candidate.baseCommit,
      workerRunId: "run-verifier",
    });
    await expect(readFile(join(recovered.path, "candidate.ts"), "utf8")).resolves.toContain(
      "retained = true",
    );
  });

  it.each([
    { state: "clean", ignoredPath: undefined },
    { state: "ignored-only", ignoredPath: ".env" },
  ])("preserves and reacquires a manifested $state candidate after restart", async ({ ignoredPath }) => {
    const { manager, repoPath, rootDir } = await makeManager();
    if (ignoredPath) {
      await writeFile(join(repoPath, ".gitignore"), `${ignoredPath}\n`, "utf8");
      await git(repoPath, ["add", ".gitignore"]);
      await git(repoPath, ["commit", "-m", "ignore local candidate state"]);
    }
    const candidate = await manager.create(holder("run-candidate"));
    await manager.persistCandidate(candidate);
    if (ignoredPath) await writeFile(join(candidate.path, ignoredPath), "retained secret\n", "utf8");

    const restarted = new WorktreeManager({ repoPath, rootDir, isProcessAlive: () => false });
    const report = await restarted.reclaimOrphans();
    expect(report.removed).toEqual([]);
    expect(report.preserved.map((entry) => entry.leaseId)).toEqual([candidate.id]);
    expect(await restarted.listLeases()).toEqual([]);
    await expect(readFile(join(candidate.path, "README.md"), "utf8")).resolves.toContain("fixture");

    const recovered = await restarted.recoverCandidate("m-1", holder("run-verifier"));
    expect(recovered.path).toBe(candidate.path);
    if (ignoredPath) {
      await expect(readFile(join(recovered.path, ignoredPath), "utf8")).resolves.toContain("retained secret");
    }
  });

  it("fails candidate recovery closed for missing, corrupt, and mismatched manifests", async () => {
    const { manager, repoPath, rootDir } = await makeManager();
    await expect(manager.recoverCandidate("missing", holder("run-missing"))).rejects.toThrow(
      /candidate_manifest_missing/u,
    );

    const candidate = await manager.create(holder("run-candidate"));
    await manager.persistCandidate(candidate);
    await writeFile(join(candidate.path, "candidate.ts"), "dirty\n");
    const restarted = new WorktreeManager({ repoPath, rootDir, isProcessAlive: () => false });
    await restarted.reclaimOrphans();
    const [manifestName] = await readdir(join(rootDir, "candidates"));
    const manifestPath = join(rootDir, "candidates", manifestName as string);
    await writeFile(manifestPath, "{broken", "utf8");
    await expect(restarted.recoverCandidate("m-1", holder("run-corrupt"))).rejects.toThrow(/corrupt/u);

    await writeFile(
      manifestPath,
      `${JSON.stringify({
        missionId: "m-1",
        path: candidate.path,
        branch: "clankie/wrong/branch",
        baseCommit: candidate.baseCommit,
      })}\n`,
      "utf8",
    );
    await expect(restarted.recoverCandidate("m-1", holder("run-mismatch"))).rejects.toThrow(
      /does not match/u,
    );
  });

  it("rejects aliased spellings of an already-leased physical path", async () => {
    const { manager } = await makeManager();
    const real = await mkdtemp(join(tmpdir(), "clankie-alias-real-"));
    const aliasParent = await mkdtemp(join(tmpdir(), "clankie-alias-link-"));
    const alias = join(aliasParent, "link");
    await symlink(real, alias);

    await manager.acquireWriteLease(real, holder("run-real"));
    await expect(manager.acquireWriteLease(alias, holder("run-alias"))).rejects.toThrow(
      /already write-leased by worker run run-real/,
    );
    // A not-yet-existing child under the aliased parent collides too.
    await manager.acquireWriteLease(join(real, "sub"), holder("run-sub"));
    await expect(manager.acquireWriteLease(join(alias, "sub"), holder("run-sub-alias"))).rejects.toThrow(
      /already write-leased by worker run run-sub/,
    );
  });

  it("continues reclamation past a lease that fails to settle", async () => {
    const { manager, repoPath, rootDir } = await makeManager();
    const locked = await manager.create(holder("run-locked"));
    await git(repoPath, ["worktree", "lock", locked.path]);
    const dirty = await manager.create(holder("run-dirty"));
    await writeFile(join(dirty.path, "wip.ts"), "// in flight\n", "utf8");

    const survivor = new WorktreeManager({ repoPath, rootDir, isProcessAlive: () => false });
    const report = await survivor.reclaimOrphans();
    expect(report.failed.map((entry) => entry.lease.id)).toEqual([locked.id]);
    expect(report.preserved.map((entry) => entry.leaseId)).toEqual([dirty.id]);

    // The failed lease survives for the next attempt; unlocking lets it settle.
    await git(repoPath, ["worktree", "unlock", locked.path]);
    const retry = await survivor.reclaimOrphans();
    expect(retry.removed.map((entry) => entry.leaseId)).toEqual([locked.id]);
    expect(retry.failed).toEqual([]);
  });

  it("removes corrupt lease files during reclamation so their paths unblock", async () => {
    const { manager, repoPath, rootDir } = await makeManager();
    await manager.acquireWriteLease(join(tmpdir(), "clankie-corrupt-scope"), holder("run-x"));
    const leaseDir = join(rootDir, "leases");
    const [file] = await readdir(leaseDir);
    await writeFile(join(leaseDir, file as string), "{not json", "utf8");

    const survivor = new WorktreeManager({ repoPath, rootDir, isProcessAlive: () => false });
    const report = await survivor.reclaimOrphans();
    expect(report.corruptRemoved).toEqual([join(leaseDir, file as string)]);
    await survivor.acquireWriteLease(join(tmpdir(), "clankie-corrupt-scope"), holder("run-y"));
  });

  it("leaves live holders untouched during reclamation", async () => {
    const { manager, repoPath, rootDir } = await makeManager();
    const lease = await manager.create(holder("run-live"));

    const restarted = new WorktreeManager({ repoPath, rootDir, isProcessAlive: () => true });
    const report = await restarted.reclaimOrphans();
    expect(report.live.map((entry) => entry.id)).toEqual([lease.id]);
    expect(report.removed).toEqual([]);
    expect((await git(repoPath, ["worktree", "list"])).includes(lease.path)).toBe(true);
  });
});
