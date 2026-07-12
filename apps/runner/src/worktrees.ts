import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "@clankie/observability";

const execFileAsync = promisify(execFile);
const logger = createLogger({ service: "clankie-runner-worktrees", version: "0.1.0" });

/** A write lease over one worktree path. Doctrine: one autonomous writer per worktree. */
export interface WorktreeLease {
  id: string;
  path: string;
  branch?: string;
  baseCommit?: string;
  missionId: string;
  taskId: string;
  workerRunId: string;
  holderPid: number;
  acquiredAt: string;
}

export interface WorktreeHolder {
  missionId: string;
  taskId: string;
  workerRunId: string;
}

export interface MissionCandidateManifest {
  missionId: string;
  path: string;
  branch: string;
  baseCommit: string;
}

export interface ReleaseResult {
  leaseId: string;
  path: string;
  outcome: "removed" | "preserved";
  /** Written only when the worktree was preserved. */
  evidencePath?: string;
}

export interface ReclaimFailure {
  lease: WorktreeLease;
  error: string;
}

export interface ReclaimReport {
  removed: ReleaseResult[];
  preserved: ReleaseResult[];
  /** Leases whose holder process is still alive; left untouched. */
  live: WorktreeLease[];
  /** Leases whose settlement failed (e.g. locked worktree); kept for the next attempt. */
  failed: ReclaimFailure[];
  /** Unparseable lease files deleted to unblock their paths. */
  corruptRemoved: string[];
}

export interface WorktreeManagerOptions {
  /** Repository the worktrees are created from. */
  repoPath: string;
  /** State root: lease records, evidence, and created worktrees live under it. */
  rootDir: string;
  clock?: () => Date;
  /** Injectable for tests; defaults to signal-0 probing. */
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Git worktree lifecycle manager (docs/05 "Worktree lifecycle").
 *
 * Leases are exclusive-create JSON files keyed by the hash of the canonical
 * (symlink-resolved) worktree path, so two workers can never hold a write
 * lease on the same physical path — under aliased spellings, within one
 * runner, or across concurrent runners sharing the state root.
 * The same records drive orphan reclamation after a crash: on restart,
 * leases whose holder process is gone are released through the normal
 * removed-when-unchanged / preserved-with-evidence-when-dirty policy.
 */
export class WorktreeManager {
  private readonly repoPath: string;
  private readonly rootDir: string;
  private readonly clock: () => Date;
  private readonly isProcessAlive: (pid: number) => boolean;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(options: WorktreeManagerOptions) {
    this.repoPath = resolve(options.repoPath);
    this.rootDir = resolve(options.rootDir);
    this.clock = options.clock ?? (() => new Date());
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  /** Create a mission/task branch + worktree from an immutable base commit and lease it. */
  public create(holder: WorktreeHolder, baseRef = "HEAD"): Promise<WorktreeLease> {
    return this.enqueue(async () => {
      const baseCommit = (await this.git(this.repoPath, ["rev-parse", "--verify", baseRef])).trim();
      const id = randomUUID();
      const slug = `${sanitizeRef(holder.missionId)}-${sanitizeRef(holder.taskId)}-${id.slice(0, 8)}`;
      const path = join(this.rootDir, "trees", slug);
      const branch = `clankie/${sanitizeRef(holder.missionId)}/${sanitizeRef(holder.taskId)}/${id.slice(0, 8)}`;
      await mkdir(join(this.rootDir, "trees"), { recursive: true });
      const lease = await this.writeLease({ id, path, branch, baseCommit, holder });
      try {
        await this.git(this.repoPath, ["worktree", "add", "-b", branch, lease.path, baseCommit]);
      } catch (error) {
        await unlink(this.leaseFile(lease.path)).catch(() => undefined);
        throw error;
      }
      logger.info(
        { ...holder, leaseId: id, path: lease.path, branch, baseCommit },
        "worktree created and leased",
      );
      return lease;
    });
  }

  /** Lease an existing path for writing without creating a worktree. */
  public acquireWriteLease(path: string, holder: WorktreeHolder): Promise<WorktreeLease> {
    return this.enqueue(() => this.writeLease({ id: randomUUID(), path: resolve(path), holder }));
  }

  /** Release a lease: remove the worktree when unchanged, preserve it (with evidence) when dirty. */
  public release(leaseId: string): Promise<ReleaseResult> {
    return this.enqueue(async () => {
      const lease = (await this.readLeases()).find((candidate) => candidate.id === leaseId);
      if (!lease) throw new Error(`Unknown worktree lease ${leaseId}`);
      return this.settle(lease);
    });
  }

  /**
   * Restart recovery: release every lease whose holder process no longer
   * exists, then prune stale git worktree registrations.
   */
  public reclaimOrphans(): Promise<ReclaimReport> {
    return this.enqueue(async () => {
      const report: ReclaimReport = { removed: [], preserved: [], live: [], failed: [], corruptRemoved: [] };
      for (const entry of await this.readLeaseEntries()) {
        if (!entry.lease) {
          await unlink(entry.file).catch(() => undefined);
          report.corruptRemoved.push(entry.file);
          logger.error({ file: entry.file }, "corrupt lease file removed during reclamation");
          continue;
        }
        if (this.isProcessAlive(entry.lease.holderPid)) {
          report.live.push(entry.lease);
          continue;
        }
        try {
          if (await this.hasMatchingCandidateManifest(entry.lease)) {
            await unlink(entry.file);
            const result: ReleaseResult = {
              leaseId: entry.lease.id,
              path: entry.lease.path,
              outcome: "preserved",
            };
            report.preserved.push(result);
            logger.warn(
              { leaseId: entry.lease.id, path: entry.lease.path, missionId: entry.lease.missionId },
              "manifested mission candidate preserved during orphan reclamation",
            );
            continue;
          }
          const result = await this.settle(entry.lease);
          report[result.outcome].push(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          report.failed.push({ lease: entry.lease, error: message });
          logger.error(
            { leaseId: entry.lease.id, path: entry.lease.path, err: message },
            "orphan settlement failed; lease kept for the next reclamation",
          );
        }
      }
      await this.git(this.repoPath, ["worktree", "prune"]).catch(() => undefined);
      logger.info(
        {
          removed: report.removed.length,
          preserved: report.preserved.length,
          live: report.live.length,
          failed: report.failed.length,
          corruptRemoved: report.corruptRemoved.length,
        },
        "worktree orphan reclamation complete",
      );
      return report;
    });
  }

  public listLeases(): Promise<WorktreeLease[]> {
    return this.enqueue(() => this.readLeases());
  }

  /** Atomically records the retained candidate independently of a process-owned lease. */
  public persistCandidate(lease: WorktreeLease): Promise<MissionCandidateManifest> {
    return this.enqueue(async () => {
      if (!lease.branch || !lease.baseCommit) {
        throw new Error(`Worktree lease ${lease.id} is not a branch candidate`);
      }
      const manifest: MissionCandidateManifest = {
        missionId: lease.missionId,
        path: lease.path,
        branch: lease.branch,
        baseCommit: lease.baseCommit,
      };
      const directory = join(this.rootDir, "candidates");
      await mkdir(directory, { recursive: true });
      const destination = this.candidateFile(lease.missionId);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temporary, destination);
      return structuredClone(manifest);
    });
  }

  /** Rebinds a preserved candidate after generic orphan reclamation removed its process lease. */
  public recoverCandidate(missionId: string, holder: WorktreeHolder): Promise<WorktreeLease> {
    return this.enqueue(async () => {
      const manifest = await this.readCandidateManifest(missionId);
      const canonicalPath = await this.canonicalize(manifest.path);
      const treesRoot = await this.canonicalize(join(this.rootDir, "trees"));
      const relativePath = relative(treesRoot, canonicalPath);
      if (
        relativePath === ".." ||
        relativePath.startsWith(`..${sep}`) ||
        resolve(canonicalPath) === treesRoot
      ) {
        throw new Error(`Candidate path ${canonicalPath} is outside the runner worktree root`);
      }
      const repositoryRoot = (await this.git(canonicalPath, ["rev-parse", "--show-toplevel"])).trim();
      const branch = (await this.git(canonicalPath, ["symbolic-ref", "--short", "HEAD"])).trim();
      const baseCommit = (
        await this.git(canonicalPath, ["rev-parse", "--verify", `${manifest.baseCommit}^{commit}`])
      ).trim();
      const mergeBase = (await this.git(canonicalPath, ["merge-base", manifest.baseCommit, "HEAD"])).trim();
      if (
        resolve(repositoryRoot) !== canonicalPath ||
        branch !== manifest.branch ||
        baseCommit !== manifest.baseCommit ||
        mergeBase !== manifest.baseCommit
      ) {
        throw new Error(`Candidate manifest for mission ${missionId} does not match the retained worktree`);
      }
      return this.writeLease({
        id: randomUUID(),
        path: canonicalPath,
        branch: manifest.branch,
        baseCommit: manifest.baseCommit,
        holder,
      });
    });
  }

  private async hasMatchingCandidateManifest(lease: WorktreeLease): Promise<boolean> {
    let manifest: MissionCandidateManifest;
    try {
      manifest = await this.readCandidateManifest(lease.missionId);
    } catch (error) {
      if (String(error).includes(`candidate_manifest_missing:${lease.missionId}`)) return false;
      throw error;
    }
    const canonicalManifestPath = await this.canonicalize(manifest.path);
    if (
      canonicalManifestPath !== lease.path ||
      manifest.branch !== lease.branch ||
      manifest.baseCommit !== lease.baseCommit
    ) {
      throw new Error(
        `Candidate manifest for mission ${lease.missionId} does not match orphaned lease ${lease.id}`,
      );
    }
    return true;
  }

  private async readCandidateManifest(missionId: string): Promise<MissionCandidateManifest> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.candidateFile(missionId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`candidate_manifest_missing:${missionId}`);
      }
      throw new Error(
        `Candidate manifest for mission ${missionId} is corrupt: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseCandidateManifest(parsed, missionId);
  }

  private async settle(lease: WorktreeLease): Promise<ReleaseResult> {
    const state = await this.inspect(lease);
    if (state.kind === "missing") {
      await this.git(this.repoPath, ["worktree", "prune"]);
      await unlink(this.leaseFile(lease.path)).catch(() => undefined);
      logger.warn({ leaseId: lease.id, path: lease.path }, "leased worktree directory was missing");
      return { leaseId: lease.id, path: lease.path, outcome: "removed" };
    }

    if (state.kind === "unchanged") {
      if (lease.branch) {
        await this.git(this.repoPath, ["worktree", "remove", lease.path]);
        await this.git(this.repoPath, ["branch", "-D", lease.branch]).catch(() => undefined);
      }
      await unlink(this.leaseFile(lease.path)).catch(() => undefined);
      logger.info({ leaseId: lease.id, path: lease.path }, "unchanged worktree removed");
      return { leaseId: lease.id, path: lease.path, outcome: "removed" };
    }

    const evidencePath = join(this.rootDir, "evidence", `${lease.id}.json`);
    await mkdir(join(this.rootDir, "evidence"), { recursive: true });
    await writeFile(
      evidencePath,
      `${JSON.stringify(
        {
          lease,
          preservedAt: this.clock().toISOString(),
          head: state.head,
          baseCommit: lease.baseCommit,
          status: state.status,
          diffStat: state.diffStat,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await unlink(this.leaseFile(lease.path)).catch(() => undefined);
    logger.warn(
      { leaseId: lease.id, path: lease.path, evidencePath },
      "dirty worktree preserved with evidence",
    );
    return { leaseId: lease.id, path: lease.path, outcome: "preserved", evidencePath };
  }

  private async inspect(
    lease: WorktreeLease,
  ): Promise<
    | { kind: "missing" }
    | { kind: "unchanged" }
    | { kind: "dirty"; head?: string; status: string; diffStat: string }
  > {
    let status: string;
    try {
      status = await this.git(lease.path, ["status", "--porcelain"]);
    } catch {
      return { kind: "missing" };
    }
    const head = lease.baseCommit ? (await this.git(lease.path, ["rev-parse", "HEAD"])).trim() : undefined;
    const committedBeyondBase = lease.baseCommit !== undefined && head !== lease.baseCommit;
    if (status.trim().length === 0 && !committedBeyondBase) return { kind: "unchanged" };
    const diffStat = lease.baseCommit
      ? await this.git(lease.path, ["diff", "--stat", lease.baseCommit]).catch(() => "")
      : "";
    return { kind: "dirty", ...(head ? { head } : {}), status, diffStat };
  }

  private async writeLease(input: {
    id: string;
    path: string;
    branch?: string;
    baseCommit?: string;
    holder: WorktreeHolder;
  }): Promise<WorktreeLease> {
    const lease: WorktreeLease = {
      id: input.id,
      path: await this.canonicalize(input.path),
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
      ...input.holder,
      holderPid: process.pid,
      acquiredAt: this.clock().toISOString(),
    };
    await mkdir(join(this.rootDir, "leases"), { recursive: true });
    try {
      // wx: exclusive create keyed by path hash — the collision guarantee.
      await writeFile(this.leaseFile(lease.path), `${JSON.stringify(lease, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.readLease(this.leaseFile(lease.path));
      throw new Error(
        `Path ${lease.path} is already write-leased by worker run ${existing?.workerRunId ?? "unknown"}` +
          ` (lease ${existing?.id ?? "unknown"}); reclaim orphans before retrying`,
      );
    }
    return lease;
  }

  private async readLeases(): Promise<WorktreeLease[]> {
    const entries = await this.readLeaseEntries();
    return entries.flatMap((entry) => (entry.lease ? [entry.lease] : []));
  }

  private async readLeaseEntries(): Promise<{ file: string; lease?: WorktreeLease }[]> {
    let files: string[];
    try {
      files = await readdir(join(this.rootDir, "leases"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries: { file: string; lease?: WorktreeLease }[] = [];
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const path = join(this.rootDir, "leases", file);
      const lease = await this.readLease(path);
      entries.push(lease ? { file: path, lease } : { file: path });
    }
    return entries;
  }

  private async readLease(file: string): Promise<WorktreeLease | undefined> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as WorktreeLease;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve symlinks so two spellings of one physical directory can never both
   * be leased (e.g. macOS /tmp vs /private/tmp). The target may not exist yet,
   * so the deepest existing ancestor is realpath'd and the remainder rejoined.
   */
  private async canonicalize(path: string): Promise<string> {
    let existing = resolve(path);
    const remainder: string[] = [];
    while (true) {
      try {
        const real = await realpath(existing);
        return remainder.length > 0 ? join(real, ...remainder) : real;
      } catch {
        const parent = dirname(existing);
        if (parent === existing) return resolve(path);
        remainder.unshift(basename(existing));
        existing = parent;
      }
    }
  }

  private leaseFile(path: string): string {
    const key = createHash("sha256").update(path).digest("hex").slice(0, 32);
    return join(this.rootDir, "leases", `${key}.json`);
  }

  private candidateFile(missionId: string): string {
    const key = createHash("sha256").update(missionId).digest("hex");
    return join(this.rootDir, "candidates", `${key}.json`);
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const result = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
    return result.stdout;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function parseCandidateManifest(value: unknown, missionId: string): MissionCandidateManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Candidate manifest for mission ${missionId} is invalid`);
  }
  const record = value as Record<string, unknown>;
  if (
    record.missionId !== missionId ||
    typeof record.path !== "string" ||
    typeof record.branch !== "string" ||
    typeof record.baseCommit !== "string"
  ) {
    throw new Error(`Candidate manifest for mission ${missionId} has mismatched fields`);
  }
  return {
    missionId,
    path: record.path,
    branch: record.branch,
    baseCommit: record.baseCommit,
  };
}

export function defaultWorktreeRoot(repoPath: string, home: string): string {
  return join(home, ".clankie", "worktrees", basename(resolve(repoPath)));
}

function sanitizeRef(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "unnamed";
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
