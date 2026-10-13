import { randomUUID } from "node:crypto";
import { syncOwnerCheckout } from "@clankie/settings";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, open, readdir, rm, rmdir, realpath, lstat } from "node:fs/promises";
import { basename, dirname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { promisify } from "node:util";
import { Writable } from "node:stream";
import {
  IntegrationBatchSchema,
  IntegrationTestRecoverySchema,
  INTEGRATE_MAX_BATCH_MEMBERS,
  type IntegrationBatch,
  type IntegrationRepo,
  type IntegrationRun,
  type IntegrationQueueStatus,
} from "@clankie/protocol/integrate";
import { durableJson, withDirectoryLock, type LockOwner } from "./deploy-holds.ts";
import { integrationEnvironment } from "./integrate-environment.ts";
import { darwinOnlySkips, remoteGateDeadline, type GateRunner } from "./integrate-remote.ts";
import {
  createResourceGovernor,
  processIdentity,
  probeProcess,
  type FleetResourceGovernor,
} from "@clankie/fleet-resources";
import { fileURLToPath } from "node:url";
import { serviceResourceDirectory } from "./service-fleet-resources.ts";
import type { FleetProgressObservation } from "./fleet-progress.ts";

import { processWorkingDirectories } from "./process-working-directories.ts";

const execute = promisify(execFile);
const now = () => new Date().toISOString();
const active = new Set(["queued", "composing", "installing", "gating", "isolating", "pushing"]);
interface PendingIntegration {
  batch: IntegrationBatch;
  guard: () => Promise<void>;
  admission: number;
}
interface IntegrationJob {
  members: PendingIntegration[];
  fresh: boolean;
  regates: number;
  regateReason?: string;
  reuse?: IntegrationBatch;
}
/** The scheduler and its status estimate use the same ordering, including restore barriers. */
function nextJob(pending: PendingIntegration[], retries: IntegrationJob[]) {
  retries.sort((a, b) => a.members[0]!.admission - b.members[0]!.admission);
  if (retries.length && (!pending.length || retries[0]!.members[0]!.admission < pending[0]!.admission))
    return retries.shift()!;
  const first = pending.shift()!;
  const members = [first];
  const request = first.batch.request;
  // Gate-only requests cannot land. Restores remain admission-order barriers.
  for (
    let index = 0;
    !request.restore && members.length < INTEGRATE_MAX_BATCH_MEMBERS && index < pending.length;
  ) {
    const next = pending[index]!.batch.request;
    if (next.restore || (retries[0] && pending[index]!.admission > retries[0].members[0]!.admission)) break;
    if (next.push === request.push) members.push(...pending.splice(index, 1));
    else index++;
  }
  return { members, fresh: false, regates: 0 };
}
interface IntegrationOptions {
  /** The service owns admission; fixtures use the service-only isolated registry. */
  governor?: () => FleetResourceGovernor;
  directory: string;
  core: string;
  app?: string;
  /**
   * Where a core-only batch's install and gate run when not here (VUH-2066):
   * a linked machine's runner when this one is saturated and that one has room.
   */
  placeGate?: (
    batch: { id: string; origin: string },
    signal?: AbortSignal,
  ) => Promise<GateRunner | undefined>;
  /** Internal deadlines, overridable by real-process integration fixtures. */
  remotePreparationTimeoutMs?: number;
  remoteCleanupTimeoutMs?: number;
  remoteExecutionTimeoutMs?: number;
  remoteNoOutputTimeoutMs?: number;
  remoteNoOutputAlertMs?: number;
}
/** Retain the failed command record before replacing it with a fresh local gate. */
class RemoteCommandFailure extends Error {
  readonly record: NonNullable<IntegrationRepo["gate"]>;
  constructor(message: string, record: NonNullable<IntegrationRepo["gate"]>) {
    super(message);
    this.record = record;
  }
}
/** Main moved after the gate and its recorded selection no longer covers the result. */
class GateNotCovering extends Error {}
/** A revalidated HEAD inherits its gate; otherwise only the gated HEAD is attested. */
const attested = (repo: IntegrationRepo) =>
  repo.revalidations?.findLast((record) => record.covered)?.head ?? repo.gate?.head;

/** The running pin can be a nested linked worktree; app lives beside its source checkout. */
/**
 * Landing runs the repository's fast, change-scoped `check:landing` when it
 * defines one; the full `check` stays for releases and manual runs.
 */
async function landingGateScript(directory: string): Promise<"check:landing" | "check"> {
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
    scripts?: Record<string, unknown>;
  };
  return typeof manifest.scripts?.["check:landing"] === "string" ? "check:landing" : "check";
}

export async function integrationSources(runtimeRoot: string): Promise<{ core: string; app: string }> {
  const { stdout } = await execute("git", [
    "-C",
    runtimeRoot,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const core = dirname(stdout.trim());
  return { core, app: join(dirname(core), "clankie-app") };
}

export class IntegrationQueue {
  private tail: Promise<void> = Promise.resolve();
  private running = new Set<string>();
  private pending: PendingIntegration[] = [];
  private retries: IntegrationJob[] = [];
  private nextAdmission = 0;
  private current: { job: IntegrationJob; batch?: IntegrationBatch; startedAt: number } | undefined;
  private withdrawn = new Set<string>();
  private durations: number[] = [];
  private writes = new Map<string, Promise<void>>();
  private draining = false;
  private readonly commands = new Map<
    string,
    {
      pid?: number;
      proof: ReturnType<typeof processIdentity>;
      remote?: { machine: string; phase: string; startedAtMs: number; lastOutputAtMs: number };
    }
  >();
  readonly options: IntegrationOptions;
  constructor(options: IntegrationOptions) {
    this.options = options;
  }
  private path(id: string): string {
    if (!/^[a-f0-9-]{36}$/u.test(id)) throw Error("Invalid batch ID");
    return join(this.options.directory, "batches", id, "record.json");
  }
  private async save(batch: IntegrationBatch): Promise<void> {
    // A cancel receipt and a queue transition for the same request cannot overwrite out of order.
    const previous = this.writes.get(batch.id) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        batch.updatedAt = now();
        await durableJson(this.path(batch.id), IntegrationBatchSchema.parse(batch));
      });
    this.writes.set(batch.id, write);
    try {
      await write;
    } finally {
      if (this.writes.get(batch.id) === write) this.writes.delete(batch.id);
    }
  }
  private async read(id: string): Promise<IntegrationBatch> {
    return IntegrationBatchSchema.parse(JSON.parse(await readFile(this.path(id), "utf8")));
  }
  async status(id: string): Promise<IntegrationBatch> {
    const batch = await this.stored(id);
    // A push request's pass is one step: while its run continues, it is landing. So is a
    // hold it is about to gate again past (VUH-2068): the request itself is still running.
    if (
      (batch.state === "passed" || batch.state === "held") &&
      batch.request.push &&
      (this.running.has(batch.id) || (batch.batchId !== undefined && this.running.has(batch.batchId)))
    )
      batch.state = "pushing";
    return this.requestProgress(batch);
  }
  private waitingJobs(): IntegrationJob[] {
    const pending = this.pending.slice();
    const retries = this.retries.filter((job) => job.members.length).slice();
    const jobs: IntegrationJob[] = [];
    while (pending.length || retries.length) {
      jobs.push(nextJob(pending, retries));
    }
    return jobs;
  }
  private async requestProgress(batch: IntegrationBatch): Promise<IntegrationBatch> {
    const matches = (job: IntegrationJob) => job.members.some((m) => m.batch.id === batch.id);
    const waiting = this.waitingJobs().findIndex(matches);
    const current = this.current && (matches(this.current.job) || this.current.batch?.id === batch.id);
    const finished = !active.has(batch.state);
    const position = finished ? null : current ? 0 : waiting < 0 ? null : waiting + 1;
    const samples = this.durations.slice().sort((a, b) => a - b);
    const duration = samples.length ? samples[Math.floor(samples.length / 2)]! : undefined;
    const remaining = finished
      ? 0
      : position === null || duration === undefined
        ? null
        : (this.current ? Math.max(duration / 10, duration - (Date.now() - this.current.startedAt)) : 0) +
          (current ? 0 : (waiting + 1) * duration);
    const chain = batch.isolation
      ? await Promise.all(
          (batch.attempts ?? []).map(async (id) => {
            const attempt = await this.read(id);
            const gate = attempt.repos.find((repo) => repo.gate)?.gate;
            return {
              batchId: id,
              memberCount: attempt.members?.length ?? 1,
              state: attempt.state,
              ...(gate ? { gateExitCode: gate.exitCode } : {}),
            };
          }),
        )
      : [];
    return {
      ...batch,
      progress: {
        queuePosition: position,
        estimatedRemainingMs: remaining,
        estimatedCompletionAt:
          remaining === null
            ? null
            : finished
              ? batch.updatedAt
              : new Date(Date.now() + remaining).toISOString(),
        estimateBasis: finished ? "finished" : remaining === null ? "unknown" : "recent-completions",
        isolationChain: chain,
      },
    };
  }
  private async stored(id: string): Promise<IntegrationBatch> {
    const receipt = await this.read(id);
    const shared = receipt.batchId ? await this.read(receipt.batchId) : receipt;
    const batch = receipt.batchId
      ? {
          ...shared,
          id: receipt.id,
          request: receipt.request,
          batchId: shared.id,
          attempts: receipt.attempts,
          isolation: receipt.isolation,
        }
      : shared;
    if (receipt.batchId && ["conflict", "failed", "cancelled"].includes(receipt.state))
      return { ...batch, state: receipt.state, error: receipt.error, cancelled: receipt.cancelled };
    // A held attempt remains durable evidence while its request waits for a fresh gate.
    if (this.retries.some((job) => job.members.some((member) => member.batch.id === id)))
      return { ...batch, state: "queued" };
    // Polling a member must not mistake the failed shared attempt for its final result.
    if (shared.state === "failed" && this.running.has(shared.id) && (shared.members?.length ?? 0) > 1)
      return { ...batch, state: "isolating" };
    // A lost process never manufactures a pass. Retain the original record for diagnosis.
    if (active.has(batch.state) && !this.running.has(shared.id))
      return {
        ...batch,
        state: "interrupted",
        error:
          "Operation interrupted or owned by another process; inspect record and retained locks before starting a fresh batch",
      };
    return batch;
  }
  async snapshot(): Promise<IntegrationQueueStatus> {
    const directory = join(this.options.directory, "batches");
    const ids = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const batches: IntegrationBatch[] = [];
    for (const id of ids) {
      if (!/^[a-f0-9-]{36}$/u.test(id)) continue;
      // The request directory can exist briefly before its first atomic record.
      const receipt = await this.read(id).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (
        receipt &&
        (!receipt.batchId || this.retries.some((job) => job.members.some((member) => member.batch.id === id)))
      )
        batches.push(await this.status(id));
    }
    batches.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const completed = batches.filter((b) => !active.has(b.state) && b.state !== "interrupted");
    completed.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {
      running: batches.filter((b) => active.has(b.state) && b.state !== "queued"),
      waiting: batches
        .filter((b) => b.state === "queued")
        .sort(
          (a, b) =>
            (a.progress?.queuePosition ?? Number.MAX_SAFE_INTEGER) -
            (b.progress?.queuePosition ?? Number.MAX_SAFE_INTEGER),
        ),
      ...(completed[0] ? { lastResult: completed[0] } : {}),
      interrupted: batches.filter((b) => b.state === "interrupted"),
    };
  }
  /** Only admitted, still live requests hold commits; a historical record is not a handoff. */
  async commitHandoffs(path: string, commits: readonly string[]) {
    const common = async (directory: string) =>
      (await this.git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
    const identity = await common(path);
    const name =
      identity === (await common(this.options.core))
        ? "core"
        : this.options.app && identity === (await common(this.options.app))
          ? "app"
          : undefined;
    if (!name) return [];
    const requests = new Map<string, IntegrationRun>();
    for (const member of [
      ...this.pending,
      ...this.retries.flatMap((job) => job.members),
      ...(this.current?.job.members ?? []),
    ]) {
      if (!this.withdrawn.has(member.batch.id)) requests.set(member.batch.id, member.batch.request);
    }
    const result: { commit: string; requestId: string }[] = [];
    for (const [requestId, request] of requests) {
      for (const ref of request[name] ?? []) {
        const commit = (
          await this.git(path, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).catch(
            () => undefined,
          )
        )?.trim();
        if (commit && commits.includes(commit)) result.push({ commit, requestId });
      }
    }
    const live = new Set<string>();
    for (const requestId of requests.keys()) {
      const batch = await this.status(requestId);
      if (this.running.has(requestId) && !this.withdrawn.has(requestId) && active.has(batch.state))
        live.add(requestId);
    }
    return result.filter((item) => live.has(item.requestId));
  }
  /** Bounded read of this queue's active heads; followers cannot page by waiting age. */
  async progress(): Promise<readonly FleetProgressObservation[]> {
    if (this.running.size > 256) throw Error("Integration progress inventory exceeds its bound");
    const heads = new Map<string, IntegrationBatch>();
    for (const id of this.running) {
      const batch = await this.stored(id);
      if (active.has(batch.state) && batch.state !== "queued") heads.set(batch.batchId ?? batch.id, batch);
    }
    const head = [...heads.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!head) return [];
    const id = head.batchId ?? head.id;
    const command = this.commands.get(id);
    if (command) {
      if (command.remote) {
        const remote = command.remote;
        const silence = Math.max(0, Date.now() - remote.lastOutputAtMs);
        return [
          {
            id: `integration:${id}:remote:${remote.phase}:${remote.startedAtMs}`,
            stalled: silence >= (this.options.remoteNoOutputAlertMs ?? 180_000),
            message: `Integration head stalled: batch ${id}, ${remote.machine} ${remote.phase}, no output since ${new Date(remote.lastOutputAtMs).toISOString()}; ${this.pending.length} requests waiting. Remote success is unproven; execution deadlines retain the reason and run a fresh local gate. Inspect clankie integrate status ${id}.`,
          },
        ];
      }
      const proof = await command.proof;
      if (!command.pid) throw Error("Integration child identity observation unavailable");
      if (!proof) throw Error("Integration child identity observation unavailable");
      const status = await probeProcess(proof);
      if (status === "unknown") throw Error("Integration child liveness unavailable");
      if (status === "live") return [];
    }
    const age = Date.now() - Date.parse(head.updatedAt);
    return [
      {
        id: `integration:${id}:${head.updatedAt}`,
        stalled: age >= 180_000,
        message: `Integration head stalled: batch ${id}, phase ${head.state}, no checkpoint progress since ${head.updatedAt}; ${this.pending.length} requests waiting. No active install/gate job is proven. Inspect clankie integrate status ${id}; no automatic cancellation, restart or resubmission.`,
      },
    ];
  }
  async start(request: IntegrationRun, guard: () => Promise<void>): Promise<IntegrationBatch> {
    try {
      const previous = await this.status(request.id);
      if (JSON.stringify(previous.request) !== JSON.stringify(request))
        throw Error("Batch ID belongs to a different request");
      return previous;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const batch: IntegrationBatch = {
      schemaVersion: 1,
      id: request.id,
      request,
      state: "queued",
      createdAt: now(),
      updatedAt: now(),
      evidence: this.path(request.id),
      repos: [],
    };
    // Reserve the batch identity before writing, including across service processes.
    await mkdir(dirname(this.path(request.id)), { recursive: false, mode: 0o700 }).catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        await mkdir(join(this.options.directory, "batches"), { recursive: true, mode: 0o700 });
        await mkdir(dirname(this.path(request.id)), { mode: 0o700 });
      },
    );
    const admission = this.nextAdmission++;
    this.running.add(batch.id);
    await this.save(batch);
    this.pending.push({ batch, guard, admission });
    this.pending.sort((a, b) => a.admission - b.admission);
    this.schedule();
    return batch;
  }
  /** Withdraw waiting requests and isolated retries before their landing begins. */
  async cancel(id: string, actor: string, reason: string): Promise<IntegrationBatch> {
    const index = this.pending.findIndex((member) => member.batch.id === id);
    const retry = this.retries.flatMap((job) => job.members).find((member) => member.batch.id === id);
    const inFlight = this.current?.job.members.find((member) => member.batch.id === id);
    const attempt = this.current?.batch;
    const isolated =
      inFlight?.batch.isolation &&
      (!attempt || ["queued", "composing", "installing", "gating", "failed"].includes(attempt.state));
    const member =
      index >= 0 ? this.pending.splice(index, 1)[0]! : (retry ?? (isolated ? inFlight : undefined));
    if (!member) {
      const previous = await this.status(id);
      if (previous.state === "cancelled") return previous;
      throw Error(
        `Request ${id} is ${previous.state}; only waiting or isolating requests before landing can be cancelled`,
      );
    }
    // Fence first, before durable I/O: a completed gate containing this member cannot land.
    this.withdrawn.add(id);
    for (const job of this.retries) job.members = job.members.filter((m) => m.batch.id !== id);
    this.retries = this.retries.filter((job) => job.members.length);
    const { batch } = member;
    batch.state = "cancelled";
    batch.cancelled = { actor, reason, at: now() };
    await this.save(batch);
    this.running.delete(batch.id);
    return batch;
  }
  private schedule(): void {
    if (this.draining) return;
    this.draining = true;
    this.tail = this.tail
      .catch(() => undefined)
      .then(async () => {
        try {
          await withDirectoryLock(
            join(this.options.directory, "queue.lock"),
            async () => {
              while (this.pending.length || this.retries.length) {
                const job = nextJob(this.pending, this.retries);
                this.current = { job, startedAt: Date.now() };
                try {
                  await this.runMembers(job);
                } finally {
                  for (const member of job.members)
                    if (
                      !this.retries.some((retry) => retry.members.some((m) => m.batch.id === member.batch.id))
                    )
                      this.running.delete(member.batch.id);
                  const completed = [this.current?.batch, job.reuse];
                  this.current = undefined;
                  const result = {
                    reclaimed: [] as string[],
                    kept: [] as { id: string; reason: string }[],
                    freedBytes: 0,
                  };
                  try {
                    const cwds = await processWorkingDirectories();
                    for (const batch of completed)
                      if (batch)
                        await this.reclaimBatch(
                          await this.read(batch.id),
                          result,
                          cwds,
                          async () => {},
                          Date.now(),
                        );
                    if (result.kept.length) console.warn("Integration cleanup retained trees", result.kept);
                  } catch (error) {
                    console.warn("Integration cleanup deferred", error);
                  }
                }
              }
            },
            (owner) => this.interruptAbandoned(owner),
            { waitForLiveOwner: true },
          );
        } catch (error) {
          // Genuine lock/observation errors retain their cause; a live writer is waited on above.
          for (const member of [
            ...this.pending.splice(0),
            ...this.retries.splice(0).flatMap((job) => job.members),
          ]) {
            member.batch.state = "failed";
            member.batch.error = String(error);
            await this.save(member.batch);
            this.running.delete(member.batch.id);
          }
        } finally {
          this.draining = false;
          if (this.pending.length || this.retries.length) this.schedule();
        }
      });
  }
  /**
   * Records what a dead queue owner left running as interrupted, with the reason
   * (VUH-2073). Requests this service accepted are running here and stay untouched.
   */
  private async interruptAbandoned(owner: LockOwner | undefined): Promise<void> {
    const ids = await readdir(join(this.options.directory, "batches")).catch(() => []);
    for (const id of ids) {
      if (!/^[a-f0-9-]{36}$/u.test(id) || this.running.has(id)) continue;
      const record = await this.read(id).catch(() => undefined);
      // A member's receipt follows its shared batch.
      if (!record || record.batchId || !active.has(record.state)) continue;
      record.error = `The queue stopped while this was ${record.state}: its lock owner (${owner ? `pid ${owner.pid} since ${owner.at}` : "unrecorded"}) died, and this service reclaimed the lock. Logs are retained; submit the request again`;
      record.state = "interrupted";
      await this.save(record);
    }
  }
  async wait(): Promise<void> {
    do {
      await this.tail;
    } while (this.draining);
  }

  /** Only disposable terminal scratch trees; passed/held/partial trees still support push. */
  private async reclaimBatch(
    batch: IntegrationBatch,
    result: { reclaimed: string[]; kept: { id: string; reason: string }[]; freedBytes: number },
    cwds: string[],
    guard: () => Promise<void>,
    at: number,
  ): Promise<void> {
    const id = batch.id;
    if (
      this.running.has(id) ||
      this.retries.some((job) => job.reuse?.id === id) ||
      this.current?.job.reuse?.id === id ||
      !["pushed", "failed", "cancelled", "interrupted", "conflict"].includes(batch.state)
    )
      return;
    const root = resolve(dirname(this.path(id)));
    const contains = (path: string) => {
      const child = relative(root, path);
      return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
    };
    try {
      if (batch.evidence !== join(root, "record.json") || (await realpath(root)) !== root)
        throw Error("batch_alias");
      if (cwds.some(contains)) throw Error("live_cwd");
      const trees = join(root, "worktrees");
      if (await lstat(trees).catch(() => undefined)) {
        if ((await realpath(trees)) !== trees) throw Error("worktrees_alias");
        for (const name of ["core", "app"] as const) {
          const tree = join(trees, name === "core" ? "clankie" : "clankie-app");
          if (!(await lstat(tree).catch(() => undefined))) continue;
          try {
            if ((await realpath(tree)) !== tree) throw Error("worktree_alias");
            const repo = batch.repos.find((repo) => repo.name === name && repo.directory === tree);
            if (!repo) throw Error("worktree_unrecorded");
            const repository = join(root, "repositories", name);
            if (
              (await realpath(repository)) !== repository ||
              (await realpath(join(repository, ".git"))) !== join(repository, ".git")
            )
              throw Error("repository_alias");
            const registration = (await this.git(repository, ["worktree", "list", "--porcelain"]))
              .split("\n\n")
              .find((entry) => entry.split("\n")[0] === `worktree ${tree}`);
            if (!registration || registration.split("\n").some((line) => line.startsWith("locked")))
              throw Error("worktree_unverified_or_locked");
            const head = registration.match(/^HEAD ([a-f0-9]{40,64})$/mu)?.[1];
            if (!head) throw Error("worktree_head_unknown");
            const marker = await lstat(join(tree, ".git")).catch(() => undefined);
            if (marker) {
              if (
                !marker.isFile() ||
                (await this.git(tree, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) !==
                  join(repository, ".git")
              )
                throw Error("worktree_unverified");
            }
            if ((await processWorkingDirectories()).some(contains)) throw Error("live_cwd");
            // du counts allocated blocks and does not follow symlinks into other checkouts.
            const { stdout } = await execute("du", ["-sk", tree], { maxBuffer: 1024 * 1024 });
            const bytes = Number(stdout.trim().split(/\s/u)[0]) * 1024;
            if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error("worktree_size_unknown");
            const keptRef = `refs/clankie/retained/${name}`;
            await this.git(repository, ["update-ref", keptRef, head]);
            await guard();
            // Gates leave tracked and untracked output. These are service-owned scratch trees.
            if (marker) await this.git(repository, ["worktree", "remove", "--force", tree]);
            else {
              // Finish an interrupted Git removal, only with its exact private registration above.
              await rm(tree, { recursive: true, force: true });
            }
            await this.git(repository, ["worktree", "prune"]);
            result.reclaimed.push(tree);
            result.freedBytes += bytes;
            (batch.worktreeReclamation ??= []).push({
              path: tree,
              head,
              keptRef,
              at: new Date(at).toISOString(),
            });
            await this.save(batch);
          } catch (error) {
            result.kept.push({ id, reason: error instanceof Error ? error.message : String(error) });
          }
        }
        if ((await readdir(trees)).length === 0) await rmdir(trees);
      }
      const isolation = join(root, "isolation");
      if (await lstat(isolation).catch(() => undefined)) {
        if ((await realpath(isolation)) !== isolation) throw Error("isolation_alias");
        // Logs must remain even if a future runner changes where it writes them.
        if (
          batch.repos.some((repo) =>
            [
              repo.install?.log,
              repo.gate?.log,
              repo.push?.log,
              ...(repo.revalidations ?? []).map((entry) => entry.log),
            ].some((log) => log && (log === isolation || log.startsWith(`${isolation}/`))),
          )
        )
          throw Error("isolation_contains_logs");
        if ((await processWorkingDirectories()).some(contains)) throw Error("live_cwd");
        const { stdout } = await execute("du", ["-sk", isolation], { maxBuffer: 1024 * 1024 });
        const bytes = Number(stdout.trim().split(/\s/u)[0]) * 1024;
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error("isolation_size_unknown");
        await guard();
        // rm removes the private tmp symlink itself, never its external target.
        await rm(isolation, { recursive: true, force: true });
        result.reclaimed.push(isolation);
        result.freedBytes += bytes;
        batch.isolationReclamation = { path: isolation, freedBytes: bytes, at: new Date(at).toISOString() };
        await this.save(batch);
      }
    } catch (error) {
      result.kept.push({ id, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Sweep every historical batch under the queue lock; records, logs and commit stores remain. */
  async reclaimWorktrees(
    at = Date.now(),
    guard: () => Promise<void> = async () => {},
  ): Promise<{ reclaimed: string[]; kept: { id: string; reason: string }[]; freedBytes: number }> {
    return withDirectoryLock(join(this.options.directory, "queue.lock"), async () => {
      await guard();
      const result = {
        reclaimed: [] as string[],
        kept: [] as { id: string; reason: string }[],
        freedBytes: 0,
      };
      const ids = await readdir(join(this.options.directory, "batches")).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        },
      );
      if (ids.length > 4096) throw Error("Integration batch census exceeds its bound");
      const cwds = await processWorkingDirectories();
      for (const id of ids) {
        if (!/^[a-f0-9-]{36}$/u.test(id)) continue;
        try {
          await this.reclaimBatch(await this.read(id), result, cwds, guard, at);
        } catch (error) {
          result.kept.push({ id, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      return result;
    });
  }
  watchReclamation(onError: (error: unknown) => void): () => void {
    let pending: Promise<unknown> | undefined;
    const sweep = () => {
      pending ??= this.reclaimWorktrees()
        .catch((error: unknown) => {
          if (!String(error).includes("Integration operation busy; retained lock:")) onError(error);
        })
        .finally(() => {
          pending = undefined;
        });
    };
    const timer = setInterval(sweep, 5 * 60_000);
    timer.unref();
    sweep();
    return () => clearInterval(timer);
  }

  private async retry(
    members: PendingIntegration[],
    regates: number,
    regateReason?: string,
    isolationRoot?: string,
    reuse?: IntegrationBatch,
  ): Promise<void> {
    const job: IntegrationJob = {
      members: members.filter((m) => !this.withdrawn.has(m.batch.id)),
      fresh: true,
      regates,
      ...(regateReason === undefined ? {} : { regateReason }),
      ...(reuse === undefined ? {} : { reuse }),
    };
    if (!job.members.length) return;
    this.retries.push(job);
    for (const member of job.members) {
      const receipt = await this.read(member.batch.id);
      if (this.withdrawn.has(member.batch.id)) continue;
      member.batch = receipt;
      // A single-request held attempt shares its original receipt directory. Preserve
      // that attestation/revalidation history; status projects its queued retry separately.
      if (receipt.state !== "held") {
        receipt.state = "queued";
        delete receipt.batchId;
        delete receipt.error;
      }
      if (isolationRoot) receipt.isolation = { rootBatchId: isolationRoot };
      this.running.add(receipt.id);
      await this.save(receipt);
    }
  }
  private async runMembers(job: IntegrationJob): Promise<void> {
    const { members: input, fresh, regates, regateReason } = job;
    const members: PendingIntegration[] = [];
    for (const member of input) {
      if (this.withdrawn.has(member.batch.id)) continue;
      try {
        await member.guard();
        if (!this.withdrawn.has(member.batch.id)) members.push(member);
      } catch (error) {
        if (this.withdrawn.has(member.batch.id)) continue;
        member.batch.state = "failed";
        member.batch.error = String(error);
        await this.save(member.batch);
      }
    }
    if (!members.length) return;
    const first = members[0]!.batch;
    const requests = members.map((m) => m.batch.request);
    const id = members.length === 1 && !fresh ? first.id : randomUUID();
    const batch: IntegrationBatch =
      id === first.id
        ? first
        : {
            schemaVersion: 1,
            id,
            // Shared options come from the first request; members retain every bounded input.
            request: { ...first.request, id },
            state: "queued",
            createdAt: now(),
            updatedAt: now(),
            evidence: this.path(id),
            repos: [],
            ...(regateReason === undefined ? {} : { regateReason }),
          };
    batch.members = requests;
    const isolationRoot = members.find((m) => m.batch.isolation)?.batch.isolation?.rootBatchId;
    if (isolationRoot) {
      batch.isolation = { rootBatchId: isolationRoot };
      batch.attempts = [...(first.attempts ?? []), id];
    }
    this.current!.batch = batch;
    this.running.add(id);
    await this.save(batch);
    for (const member of members) {
      if (member.batch.id === id) continue;
      member.batch.batchId = id;
      member.batch.attempts = [...(member.batch.attempts ?? []), id];
      await this.save(member.batch);
    }
    let remaining = members;
    try {
      try {
        await this.composeAndGate(batch, job.reuse);
      } catch (error) {
        batch.state = "failed";
        batch.error = String(error);
        await this.save(batch);
      }
      remaining = members.filter((m) => !batch.excluded?.some((e) => e.id === m.batch.id));
      const withdrawn = members.filter((m) => this.withdrawn.has(m.batch.id));
      remaining = remaining.filter((m) => !this.withdrawn.has(m.batch.id));
      if (batch.repos.some((repo) => repo.gate)) {
        this.durations.push(Date.now() - this.current!.startedAt);
        this.durations = this.durations.slice(-8);
      }
      for (const excluded of batch.excluded ?? []) {
        const member = members.find((m) => m.batch.id === excluded.id)!;
        if (member.batch.id !== id && !this.withdrawn.has(member.batch.id)) {
          member.batch.state = excluded.state;
          member.batch.error = excluded.error;
          await this.save(member.batch);
        }
      }
      if (withdrawn.length) {
        // Even a green gate attests the withdrawn member's tree. Never subtract it from a pass.
        batch.state = "failed";
        batch.error = `Withdrawn requests ${withdrawn.map((m) => m.batch.id).join(", ")}; surviving requests need a fresh tree and gate`;
        await this.save(batch);
        await this.retry(remaining, regates, batch.error, isolationRoot);
      } else if (batch.state === "failed" && remaining.length > 1) {
        batch.error = `${batch.error ?? "Shared gate failed"}; individual retries queued (use request IDs)`;
        await this.save(batch);
        // Cap the diagnosis at a shared attempt plus one individual gate per member.
        // Each retry keeps its original admission priority, before later arrivals.
        for (const member of remaining)
          await this.retry([member], regates, undefined, isolationRoot ?? id, batch);
      } else if (batch.state === "passed" && batch.request.push) {
        let uncovered = false;
        await this.land(
          id,
          async () => {
            for (const member of remaining) await member.guard();
          },
          () => (uncovered = true),
        );
        // Main moved somewhere the gate checked: compose and gate again, at most twice.
        if (uncovered && regates < 2) {
          const held = await this.stored(id);
          const reason = held.error!;
          held.error = `${reason}; gating again on the new main`;
          await this.save(held);
          // The held attempt is finished; its requests keep running and follow the fresh batch.
          if (!members.some((member) => member.batch.id === id)) this.running.delete(id);
          const again: PendingIntegration[] = [];
          for (const member of remaining) again.push({ ...member, batch: await this.read(member.batch.id) });
          await this.retry(again, regates + 1, reason, isolationRoot);
        }
      }
    } finally {
      if (!this.retries.some((retry) => retry.members.some((m) => m.batch.id === id)))
        this.running.delete(id);
    }
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    // The clone's local config disables client hooks. Do not forward a -c hook override to
    // a local receive-pack: disposable bare origins must retain their real server hooks.
    const hookArgs = args[0] === "push" ? [] : ["-c", "core.hooksPath=/dev/null"];
    const { stdout } = await execute("git", [...hookArgs, "-C", cwd, ...args], {
      env,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  }
  private async head(repo: IntegrationRepo): Promise<string> {
    return this.git(repo.directory, ["rev-parse", "HEAD"]);
  }
  private async clean(repo: IntegrationRepo): Promise<void> {
    if (await this.git(repo.directory, ["status", "--porcelain"]))
      throw Error(`${repo.name} worktree changed; gate cannot attest it`);
  }
  private async remoteCommand(
    batchId: string,
    runner: GateRunner,
    phase: "install" | "gate",
    base: string,
    out: Writable,
  ): Promise<{ exitCode: number | null; signal: string | null }> {
    const controller = new AbortController();
    const wallMs = this.options.remoteExecutionTimeoutMs ?? 5_400_000;
    const silenceMs = this.options.remoteNoOutputTimeoutMs ?? 600_000;
    const remote = { machine: runner.machine, phase, startedAtMs: Date.now(), lastOutputAtMs: Date.now() };
    this.commands.set(batchId, { proof: Promise.resolve(undefined), remote });
    let wall: ReturnType<typeof setTimeout> | undefined;
    let silence: ReturnType<typeof setTimeout> | undefined;
    let fail!: (error: Error) => void;
    const expired = new Promise<never>((_, reject) => {
      fail = (error) => {
        controller.abort(error);
        reject(error);
      };
      wall = setTimeout(
        () => fail(Error(`${runner.machine} ${phase} exceeded wall-clock deadline ${wallMs}ms`)),
        wallMs,
      );
    });
    const resetSilence = () => {
      clearTimeout(silence);
      silence = setTimeout(
        () => fail(Error(`${runner.machine} ${phase} produced no output for ${silenceMs}ms`)),
        silenceMs,
      );
    };
    const relay = new Writable({
      write(chunk, encoding, done) {
        remote.lastOutputAtMs = Date.now();
        resetSilence();
        out.write(chunk, encoding, done);
      },
    });
    relay.on("error", fail);
    out.once("error", fail);
    resetSilence();
    try {
      return await Promise.race([runner.run(phase, base, relay, controller.signal), expired]);
    } finally {
      clearTimeout(wall);
      clearTimeout(silence);
      out.off("error", fail);
      // Drain bytes already accepted by the relay before the durable log closes.
      await new Promise<void>((resolve) => relay.end(resolve));
      // Buffered writes can reset silence while draining; leave no timer behind.
      clearTimeout(silence);
      relay.destroy();
    }
  }

  private async command(
    repo: IntegrationRepo,
    name: "install" | "gate" | "revalidate",
    env: NodeJS.ProcessEnv,
    evidence: string,
    base = repo.base,
    runner?: GateRunner,
  ): Promise<NonNullable<IntegrationRepo["gate"]>> {
    // Install and gate run once per batch; revalidation runs each time main moves.
    const log = join(
      evidence,
      name === "revalidate"
        ? `${repo.name}-revalidate-${now().replaceAll(":", "-")}.log`
        : runner
          ? `${repo.name}-${name}-${runner.machine.replaceAll(/[^\w-]/gu, "_")}.log`
          : `${repo.name}-${name}.log`,
    );
    const startedAt = now();
    const head = await this.head(repo);
    const gateScript = name === "install" ? "check" : await landingGateScript(repo.directory);
    const batchId = basename(evidence);
    let remoteError: string | undefined;
    const result = await new Promise<{ exitCode: number | null; signal: string | null }>(
      (resolve, reject) => {
        const out = createWriteStream(log, { flags: "wx", mode: 0o600 });
        out.on("error", reject);
        // A linked machine streams the same output into the same log.
        if (runner && name !== "revalidate") {
          this.remoteCommand(batchId, runner, name, base, out).then(
            (result) => out.end(() => resolve(result)),
            (error: unknown) => {
              remoteError = error instanceof Error ? error.message : String(error);
              out.end(`\n${remoteError}\n`, () => resolve({ exitCode: null, signal: null }));
            },
          );
          return;
        }
        const args =
          name === "install"
            ? [
                "install",
                "--frozen-lockfile",
                "--store-dir",
                env.npm_config_store_dir!,
                "--package-import-method=copy",
              ]
            : name === "gate"
              ? [
                  gateScript,
                  ...(repo.name === "core" && gateScript === "check:landing" ? ["--retry-failed-tests"] : []),
                ]
              : [gateScript, "--revalidate"];
        const child = spawn("pnpm", args, {
          cwd: repo.directory,
          env: name === "install" ? env : { ...env, CLANKIE_LANDING_BASE: base },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const proof = child.pid ? processIdentity(child.pid) : Promise.resolve(undefined);
        void proof.catch(() => undefined);
        this.commands.set(batchId, { ...(child.pid ? { pid: child.pid } : {}), proof });
        child.stdout.pipe(out, { end: false });
        child.stderr.pipe(out, { end: false });
        child.on("error", (error) => {
          out.end(String(error));
          reject(error);
        });
        child.on("close", (exitCode, signal) => {
          out.end(() => resolve({ exitCode, signal }));
        });
      },
    ).finally(() => this.commands.delete(batchId));
    const file = await open(log, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    const record = {
      head,
      ...result,
      startedAt,
      finishedAt: now(),
      log,
      ...(runner && name !== "revalidate" ? { machine: runner.machine } : {}),
    };
    if (name === "gate" && !runner) {
      const recovery = await this.testRecovery(repo, head);
      if (recovery) Object.assign(record, { testRecovery: recovery });
    }
    if (remoteError !== undefined) throw new RemoteCommandFailure(remoteError, record);
    return record;
  }

  private async testRecovery(repo: IntegrationRepo, head: string) {
    let report: { head?: string; testRecovery?: unknown } | undefined;
    try {
      report = JSON.parse(await readFile(join(repo.directory, ".local/landing-gate.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (report?.testRecovery !== undefined) {
      if (report.head !== head) throw new Error("Test recovery report does not match the gated HEAD");
      return IntegrationTestRecoverySchema.parse(report.testRecovery);
    }
  }

  private async composeAndGate(batch: IntegrationBatch, reuse?: IntegrationBatch): Promise<void> {
    const root = dirname(batch.evidence);
    const restore = batch.request.restore ? await this.status(batch.request.restore) : undefined;
    if (restore && !["passed", "held", "pushed", "partial"].includes(restore.state))
      throw Error("Restore requires a recorded passed batch");
    const names: ("core" | "app")[] = restore
      ? restore.repos.map((r) => r.name)
      : (batch.members ?? [batch.request]).some((member) => member.app !== undefined)
        ? ["core", "app"]
        : ["core"];
    batch.state = "composing";
    await this.save(batch);
    for (const name of names) {
      const source = name === "core" ? this.options.core : this.options.app;
      if (!source) throw Error("App repository is unavailable");
      const origin = await this.git(source, ["remote", "get-url", "origin"]);
      const repository = join(root, "repositories", name);
      await mkdir(dirname(repository), { recursive: true, mode: 0o700 });
      await this.git(root, ["clone", "--no-hardlinks", "--no-checkout", source, repository]);
      await this.git(repository, ["remote", "set-url", "origin", origin]);
      await this.git(repository, ["config", "core.hooksPath", "/dev/null"]);
      await this.git(repository, ["config", "user.name", "Clankie"]);
      await this.git(repository, ["config", "user.email", "integrate@clankie.bot"]);
      await this.git(repository, ["config", "commit.gpgsign", "false"]);
      await this.git(repository, ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
      const base = await this.git(repository, ["rev-parse", "refs/remotes/origin/main"]);
      const directory = join(root, "worktrees", name === "core" ? "clankie" : "clankie-app");
      await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
      await this.git(repository, ["worktree", "add", "--detach", directory, base]);
      const repo: IntegrationRepo = {
        name,
        source,
        origin,
        base,
        directory,
        head: base,
        commits: (batch.members ?? [batch.request]).flatMap((member) =>
          (name === "core" ? member.core : (member.app ?? [])).map((commit) => ({
            commit,
            memberId: member.id,
            state: "pending" as const,
          })),
        ),
      };
      batch.repos.push(repo);
      await this.save(batch);
      if (restore) {
        const good = restore.repos.find((r) => r.name === name)!;
        if (
          good.source !== source ||
          good.origin !== origin ||
          good.gate?.exitCode !== 0 ||
          good.gate.head !== good.head
        )
          throw Error("Restore source does not match a recorded passed tree");
        const retained = join(dirname(dirname(good.directory)), "repositories", name);
        await this.git(directory, [
          "fetch",
          (await lstat(good.directory).catch(() => undefined)) ? good.directory : retained,
          good.head,
        ]);
        await this.git(directory, ["read-tree", "--reset", "-u", `${good.head}^{tree}`]);
        await this.git(directory, [
          "commit",
          "--allow-empty",
          "-m",
          `Restore ${name} tree from passed integration ${restore.id} (${good.head})`,
        ]);
        repo.head = await this.head(repo);
        await this.save(batch);
      }
    }
    batch.excluded = [];
    for (const member of batch.members ?? [batch.request]) {
      const before = batch.repos.map((r) => r.head);
      let failure: NonNullable<IntegrationBatch["excluded"]>[number] | undefined;
      for (const repo of batch.repos) {
        for (const item of repo.commits.filter((c) => c.memberId === member.id)) {
          if (failure) {
            item.state = "blocked";
            continue;
          }
          try {
            const commit = await this.git(repo.source, ["rev-parse", "--verify", `${item.commit}^{commit}`]);
            item.commit = commit;
            await this.git(repo.directory, ["fetch", repo.source, commit]);
            const ancestry = await this.git(repo.directory, ["merge-base", commit, "HEAD"]);
            if (ancestry === commit) item.state = "already_present";
            else {
              await this.git(repo.directory, ["cherry-pick", "--empty=drop", commit]);
              item.state = "applied";
            }
            repo.head = await this.head(repo);
            item.head = repo.head;
          } catch (error) {
            const conflicts = (await this.git(repo.directory, ["diff", "--name-only", "--diff-filter=U"]))
              .split("\n")
              .filter(Boolean);
            item.state = conflicts.length ? "conflict" : "failed";
            item.conflicts = conflicts;
            item.error = String(error);
            failure = { id: member.id, state: item.state, error: item.error };
          }
          await this.save(batch);
        }
      }
      if (failure) {
        batch.excluded.push(failure);
        // A request is atomic across both siblings. Roll it back before applying another member.
        for (const [index, repo] of batch.repos.entries()) {
          await this.git(repo.directory, ["cherry-pick", "--abort"]).catch(() => undefined);
          await this.git(repo.directory, ["reset", "--hard", before[index]!]);
          repo.head = before[index]!;
          for (const item of repo.commits.filter((c) => c.memberId === member.id && c.state === "applied")) {
            item.state = "blocked";
            delete item.head;
          }
        }
      }
      await this.save(batch);
    }
    if (batch.excluded.length === (batch.members ?? [batch.request]).length) {
      batch.state = batch.excluded.some((e) => e.state === "conflict") ? "conflict" : "failed";
      batch.error = batch.excluded.map((e) => `${e.id}: ${e.error}`).join("; ");
      await this.save(batch);
      return;
    }
    if (reuse && !restore) await this.reusePassedGates(batch, reuse);
    // A core-only batch may gate on a linked machine; an app pair gates together here.
    const runner = await this.place(batch);
    try {
      await this.installAndGate(batch, root, runner);
    } finally {
      const cleanup = await this.disposeRunner(runner);
      if (cleanup) {
        batch.placement = {
          machine: batch.placement?.machine ?? runner!.machine,
          reason: `${batch.placement?.reason ?? ""}; ${cleanup}`.slice(0, 500),
        };
        await this.save(batch);
      }
    }
  }

  /** Preserve the actual gated commit, never relabel a pass for a newly composed HEAD. */
  private async reusePassedGates(batch: IntegrationBatch, previous: IntegrationBatch): Promise<void> {
    for (const member of previous.members ?? [previous.request])
      if (this.withdrawn.has(member.id) || (await this.read(member.id)).state === "cancelled") return;
    for (const repo of batch.repos) {
      const good = previous.repos.find((candidate) => candidate.name === repo.name);
      if (
        !good ||
        good.gate?.exitCode !== 0 ||
        good.gate.head !== good.head ||
        good.base !== repo.base ||
        good.source !== repo.source ||
        good.origin !== repo.origin
      )
        continue;
      // The app consumes the core candidate. Treat other siblings conservatively too.
      if (
        previous.repos.some(
          (sibling) =>
            sibling.name !== repo.name &&
            batch.repos.find((candidate) => candidate.name === sibling.name)?.head !== sibling.head,
        )
      )
        continue;
      const contributions = (candidate: IntegrationRepo) =>
        candidate.commits
          .filter((item) => item.state === "applied" || item.state === "already_present")
          .map(({ commit, memberId }) => ({ commit, memberId }));
      if (JSON.stringify(contributions(repo)) !== JSON.stringify(contributions(good))) continue;
      let tree: string;
      try {
        if ((await this.head(good)) !== good.head) continue;
        await this.clean(good);
        tree = await this.git(repo.directory, ["rev-parse", `${repo.head}^{tree}`]);
        if (tree !== (await this.git(good.directory, ["rev-parse", `${good.head}^{tree}`]))) continue;
      } catch {
        // Missing prior evidence cannot authorize reuse; the fresh candidate must gate.
        continue;
      }
      await this.git(repo.directory, ["fetch", good.directory, good.head]);
      await this.git(repo.directory, ["reset", "--hard", good.head]);
      repo.head = good.head;
      repo.commits = good.commits.map((item) => ({ ...item }));
      repo.gate = { ...good.gate };
      repo.gateReuse = { batchId: previous.id, tree, coreHead: previous.repos[0]!.head };
      await this.save(batch);
    }
  }

  private async disposeRunner(runner?: GateRunner): Promise<string | undefined> {
    if (!runner) return;
    return remoteGateDeadline(
      `${runner.machine} cleanup`,
      this.options.remoteCleanupTimeoutMs ?? 10_000,
      (signal) => runner.dispose(signal),
    ).then(
      () => undefined,
      (error) => String(error),
    );
  }

  /** The linked machine that will gate this batch, staged at its exact HEAD, or here. */
  private async place(batch: IntegrationBatch): Promise<GateRunner | undefined> {
    const repo = batch.repos[0];
    if (!this.options.placeGate || batch.repos.length !== 1 || repo?.name !== "core") return undefined;
    let runner: GateRunner | undefined;
    let phase = "placement";
    try {
      await remoteGateDeadline(
        () => phase,
        this.options.remotePreparationTimeoutMs ?? 120_000,
        async (signal) => {
          const placed = await this.options.placeGate!({ id: batch.id, origin: repo.origin }, signal);
          // A late provider response cannot start staging after fallback has begun.
          if (signal.aborted) {
            void this.disposeRunner(placed);
            signal.throwIfAborted();
          }
          runner = placed;
          if (!runner) return;
          await this.clean(repo);
          signal.throwIfAborted();
          phase = `${runner.machine} stage`;
          await runner.stage(repo, signal);
        },
      );
      if (!runner) return undefined;
      batch.placement = { machine: runner.machine };
      await this.save(batch);
      return runner;
    } catch (error) {
      // The gate still runs: here, with the reason it could not go there.
      const cleanup = await this.disposeRunner(runner);
      batch.placement = {
        machine: "local",
        reason: `${String(error)}; gating locally${cleanup ? `; ${cleanup}` : ""}`.slice(0, 500),
      };
      await this.save(batch);
      return undefined;
    }
  }

  private async localGate(batch: IntegrationBatch, root: string): Promise<void> {
    const phases = [];
    for (const repo of batch.repos) {
      await this.clean(repo);
      const env = await integrationEnvironment(join(root, "isolation", repo.name));
      phases.push({
        repo: repo.name,
        name: "install",
        directory: repo.directory,
        env,
        args: [
          "install",
          "--frozen-lockfile",
          "--store-dir",
          env.npm_config_store_dir!,
          "--package-import-method=copy",
        ],
        log: join(root, `${repo.name}-install.log`),
      });
    }
    for (const repo of batch.repos) {
      if (repo.gateReuse) continue;
      const script = await landingGateScript(repo.directory);
      phases.push({
        repo: repo.name,
        name: "gate",
        directory: repo.directory,
        env: {
          ...(await integrationEnvironment(join(root, "isolation", repo.name))),
          CLANKIE_LANDING_BASE: repo.base,
        },
        args: [
          script,
          ...(repo.name === "core" && script === "check:landing" ? ["--retry-failed-tests"] : []),
        ],
        log: join(root, `${repo.name}-gate.log`),
      });
    }
    const resourceDirectory = this.options.governor ? undefined : await serviceResourceDirectory();
    const governor =
      this.options.governor?.() ??
      createResourceGovernor(resourceDirectory?.directory ? { directory: resourceDirectory.directory } : {});
    const errors = createWriteStream(join(root, `gate-runner-${randomUUID()}.log`), { mode: 0o600 });
    let pending = "";
    let updates = Promise.resolve();
    const output = new Writable({
      write: (bytes, _encoding, done) => {
        pending += bytes.toString();
        for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          updates = updates.then(async () => {
            const event = JSON.parse(line) as {
              type: "ready" | "begin" | "end";
              pid: number;
              repo: "core" | "app";
              phase: "install" | "gate";
              record: NonNullable<IntegrationRepo["gate"]>;
            };
            if (event.type === "ready") {
              const proof = processIdentity(event.pid);
              void proof.catch(() => undefined);
              this.commands.set(batch.id, { pid: event.pid, proof });
              return;
            }
            if (event.type === "begin") batch.state = event.phase === "install" ? "installing" : "gating";
            else {
              const repo = batch.repos.find((repo) => repo.name === event.repo)!;
              if (event.phase === "gate") {
                const recovery = await this.testRecovery(repo, event.record.head);
                if (recovery) event.record.testRecovery = recovery;
              }
              repo[event.phase] = event.record;
            }
            await this.save(batch);
          });
        }
        updates.then(() => done(), done);
      },
    });
    // The queued receipt promise rejects the batch; stream errors must not exit the service.
    output.on("error", () => {});
    try {
      const code = await governor.runHeavy(
        process.execPath,
        [fileURLToPath(new URL("./integrate-gate-driver.mjs", import.meta.url))],
        {
          mergeGate: batch.id,
          holderId: `integration:${batch.id}`,
          input: JSON.stringify({ phases }),
          stdout: output,
          stderr: errors,
        },
      );
      await updates;
      if (pending.trim()) throw new Error("Incomplete integration phase receipt");
      if (code !== 0 && batch.repos.some((repo) => repo.install?.exitCode !== 0)) {
        batch.state = "failed";
        await this.save(batch);
      } else if (code !== 0 && batch.repos.every((repo) => repo.gateReuse || repo.gate?.exitCode === 0)) {
        throw new Error(`Integration runner exited ${code} without a failed phase receipt`);
      }
    } finally {
      this.commands.delete(batch.id);
      errors.end();
      output.destroy();
      if (!this.options.governor) await governor.close();
      await resourceDirectory?.dispose();
    }
  }

  private async installAndGate(batch: IntegrationBatch, root: string, runner?: GateRunner): Promise<void> {
    if (!runner) {
      await this.localGate(batch, root);
      if (batch.state !== "failed") await this.verifyGates(batch);
      return;
    }
    // Install every sibling before either gate; both gates validate the exact composed pair.
    batch.state = "installing";
    await this.save(batch);
    for (const repo of batch.repos) {
      const env = await integrationEnvironment(join(root, "isolation", repo.name));
      await this.clean(repo);
      try {
        repo.install = await this.command(repo, "install", env, root, repo.base, runner);
      } catch (error) {
        if (!runner || !(error instanceof RemoteCommandFailure)) throw error;
        repo.install = error.record;
        await this.save(batch);
        return this.regateHere(batch, root, runner, error.message);
      }
      await this.save(batch);
      if (runner && repo.install.exitCode !== 0)
        return this.regateHere(batch, root, runner, `install exited ${repo.install.exitCode}`);
      if (repo.install.exitCode !== 0) {
        batch.state = "failed";
        await this.save(batch);
        return;
      }
    }
    batch.state = "gating";
    await this.save(batch);
    for (const repo of batch.repos) {
      const env = await integrationEnvironment(join(root, "isolation", repo.name));
      if (repo.gateReuse) continue;
      try {
        repo.gate = await this.command(repo, "gate", env, root, repo.base, runner);
        // A connected report transport must not strand a completed remote gate either.
        if (runner)
          await remoteGateDeadline(
            `${runner.machine} gate report`,
            this.options.remotePreparationTimeoutMs ?? 120_000,
            (signal) => runner.collect(repo.directory, signal),
          );
        if (runner) {
          const recovery = await this.testRecovery(repo, repo.gate.head);
          if (recovery) repo.gate.testRecovery = recovery;
        }
      } catch (error) {
        if (!runner) throw error;
        if (error instanceof RemoteCommandFailure) repo.gate = error.record;
        else if (repo.gate) {
          const log = await open(repo.gate.log, "a");
          try {
            await log.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
            await log.sync();
          } finally {
            await log.close();
          }
        }
        await this.save(batch);
        return this.regateHere(batch, root, runner, error instanceof Error ? error.message : String(error));
      }
      await this.save(batch);
    }
    if (runner) {
      const repo = batch.repos[0]!;
      if (repo.gate?.exitCode !== 0)
        return this.regateHere(batch, root, runner, `gate exited ${repo.gate?.exitCode}`);
      const skipped = await darwinOnlySkips(repo.directory);
      if (skipped.length)
        return this.regateHere(batch, root, runner, `skipped darwin-only tests in ${skipped.join(", ")}`);
    }
    await this.verifyGates(batch);
  }

  private async verifyGates(batch: IntegrationBatch): Promise<void> {
    for (const repo of batch.repos) {
      if (
        repo.gate?.exitCode !== 0 ||
        repo.gate.head !== (await this.head(repo)) ||
        repo.head !== repo.gate.head
      )
        throw Error(`${repo.name} gate failed or HEAD changed; see ${repo.gate?.log}`);
      await this.clean(repo);
    }
    batch.state = "passed";
    await this.save(batch);
  }

  /**
   * A linked machine's gate counts only when it is green and skipped no darwin-only
   * test; anything else gates again here, keeping that machine's logs (VUH-2066).
   */
  private async regateHere(
    batch: IntegrationBatch,
    root: string,
    runner: GateRunner,
    why: string,
  ): Promise<void> {
    const repo = batch.repos[0]!;
    batch.placement = {
      machine: "local",
      reason:
        `${runner.machine} ${why}; regated here (its log: ${repo.gate?.log ?? repo.install?.log})`.slice(
          0,
          500,
        ),
    };
    delete repo.install;
    delete repo.gate;
    await rm(join(repo.directory, ".local"), { recursive: true, force: true });
    await this.save(batch);
    await this.installAndGate(batch, root);
  }

  /**
   * Rebases a green repo onto the newer origin/main and asks its gate whether the recorded
   * selection still covers the result (`check:landing --revalidate`, VUH-2024). Returns why
   * not, with the worktree back on the HEAD it had.
   */
  private async revalidate(batch: IntegrationBatch, repo: IntegrationRepo): Promise<string | undefined> {
    const root = dirname(batch.evidence);
    await this.git(repo.directory, ["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
    const to = await this.git(repo.directory, ["rev-parse", "refs/remotes/origin/main"]);
    const record: NonNullable<IntegrationRepo["revalidations"]>[number] = {
      from: repo.base,
      to,
      incoming: (await this.git(repo.directory, ["rev-list", "--reverse", `${repo.base}..${to}`]))
        .split("\n")
        .filter(Boolean),
      previousHead: repo.head,
      covered: false,
      at: now(),
    };
    (repo.revalidations ??= []).push(record);
    await this.save(batch);
    let reason: string | undefined;
    if ((await landingGateScript(repo.directory)) !== "check:landing")
      reason = "its gate records no selection to revalidate";
    else if ((await this.git(repo.directory, ["merge-base", repo.base, to])) !== repo.base)
      reason = `origin/main no longer contains the gated base ${repo.base}`;
    else
      try {
        await this.git(repo.directory, ["rebase", "--onto", to, repo.base]);
        record.head = await this.head(repo);
      } catch (error) {
        const conflicts = (await this.git(repo.directory, ["diff", "--name-only", "--diff-filter=U"]))
          .split("\n")
          .filter(Boolean);
        await this.git(repo.directory, ["rebase", "--abort"]).catch(() => undefined);
        reason = conflicts.length
          ? `rebasing onto it conflicts in ${conflicts.join(", ")}`
          : `rebasing onto it failed: ${String(error)}`;
      }
    if (record.head)
      try {
        const env = await integrationEnvironment(join(root, "isolation", repo.name));
        const result = await this.command(repo, "revalidate", env, root, to);
        record.exitCode = result.exitCode;
        record.log = result.log;
        if (result.exitCode !== 0)
          reason =
            (await readFile(result.log, "utf8")).match(/^\[landing\] rerun the root gate: (.+)$/mu)?.[1] ??
            `check:landing --revalidate exited ${result.exitCode ?? result.signal}`;
        else if ((await this.head(repo)) !== record.head) reason = "HEAD changed during revalidation";
        else if (await this.git(repo.directory, ["status", "--porcelain"]))
          reason = "revalidation left the worktree changed";
      } catch (error) {
        reason = `revalidation could not run: ${String(error)}`;
      }
    if (reason) {
      record.reason = reason;
      await this.git(repo.directory, ["reset", "--hard", record.previousHead]);
    } else {
      record.covered = true;
      repo.base = to;
      repo.head = record.head!;
    }
    await this.save(batch);
    return reason;
  }

  /** Deploy holds protect the running service, not main, so landing never waits for one (ADR 0240). */
  async land(id: string, guard: () => Promise<void>, onUncovered?: () => void): Promise<IntegrationBatch> {
    const batch = await this.stored(id);
    if (batch.batchId) {
      if (["conflict", "failed", "interrupted", "cancelled"].includes(batch.state))
        throw Error(`Request ${id} has no landable pass (${batch.state})`);
      await this.land(batch.batchId, guard);
      return this.status(id);
    }
    if (batch.state === "pushed") return batch;
    if (!["passed", "held", "partial"].includes(batch.state))
      throw Error(`Batch ${id} has no landable pass (${batch.state})`);
    const wasRunning = this.running.has(id);
    this.running.add(id);
    try {
      return await withDirectoryLock(join(dirname(batch.evidence), "push.lock"), async () => {
        try {
          await guard();
          // Read the persisted attestation rather than trusting an in-memory check result.
          const recorded = await this.stored(id);
          for (const member of recorded.members ?? [recorded.request]) {
            if (this.withdrawn.has(member.id) || (await this.read(member.id)).state === "cancelled")
              throw Error(`Request ${member.id} was withdrawn; compose and gate surviving requests again`);
          }
          recorded.repos.sort((a, b) => (a.name === b.name ? 0 : a.name === "core" ? -1 : 1));
          if (!recorded.repos.length) throw Error("No repositories were gated");
          for (const repo of recorded.repos) {
            if (
              repo.gateReuse &&
              (repo.gateReuse.coreHead !== recorded.repos[0]!.head ||
                repo.gateReuse.tree !==
                  (await this.git(repo.directory, ["rev-parse", `${repo.head}^{tree}`])))
            )
              throw Error(`${repo.name}: reused gate does not cover this tree and core candidate`);
            if (
              repo.gate?.exitCode !== 0 ||
              attested(repo) !== repo.head ||
              repo.head !== (await this.head(repo))
            )
              throw Error(`${repo.name}: recorded gate is not a pass for exact HEAD`);
            await this.clean(repo);
            if ((await this.git(repo.directory, ["remote", "get-url", "origin"])) !== repo.origin)
              throw Error(`${repo.name}: origin changed since composition`);
            if ((await this.git(repo.directory, ["remote", "get-url", "--push", "origin"])) !== repo.origin)
              throw Error(`${repo.name}: push destination changed since composition`);
            const remote = async () =>
              (await this.git(repo.directory, ["ls-remote", "origin", "refs/heads/main"])).split(/\s/u)[0];
            let current = await remote();
            if (repo.push && repo.push.state !== "confirmed" && repo.push.state !== "rejected") {
              // Reconcile an uncertain send, never replay it.
              if (current !== repo.head)
                throw Error(
                  `${repo.name}: previous push unconfirmed; inspect origin and start a fresh batch`,
                );
              repo.push.state = "confirmed";
              repo.ownerCheckoutSync = await syncOwnerCheckout(repo.source);
              await this.save(recorded);
            }
            if (repo.push?.state === "confirmed") {
              if (current !== repo.head)
                throw Error(`${repo.name}: origin advanced after landing; start a fresh batch`);
            } else
              // A green gate survives a moved main while its recorded selection still covers HEAD.
              for (let round = 0; current !== repo.base; round++) {
                const from = repo.base;
                const why =
                  round === 3
                    ? "origin/main kept moving"
                    : recorded.request.restore
                      ? "a restore is composed again on the current main"
                      : repo.gateReuse
                        ? "a reused gate requires an unchanged base"
                        : repo.name === "core" && recorded.repos.some((r) => r.name === "app")
                          ? "the app gate ran against the earlier core"
                          : await this.revalidate(recorded, repo);
                if (why)
                  throw new GateNotCovering(
                    `${repo.name}: origin/main moved from ${from} to ${current} and the gate no longer covers HEAD: ${why}`,
                  );
                current = await remote();
              }
          }
          recorded.state = "pushing";
          delete recorded.error;
          await this.save(recorded);
          for (const repo of recorded.repos) {
            if (repo.push?.state === "confirmed") continue;
            await guard();
            // Recheck both HEADs after each network operation, including the sibling dependency.
            for (const sibling of recorded.repos) {
              if (sibling.head !== (await this.head(sibling)))
                throw Error(`${sibling.name}: HEAD changed after gate`);
              await this.clean(sibling);
            }
            const log = join(
              dirname(recorded.evidence),
              `${repo.name}-push-${now().replaceAll(":", "-")}.log`,
            );
            repo.push = { state: "attempting", at: now(), exitCode: null, log };
            await this.save(recorded);
            try {
              const output = await this.git(repo.directory, [
                "push",
                "--porcelain",
                "origin",
                `${repo.head}:refs/heads/main`,
              ]);
              await durableJson(log, { stdout: output });
              repo.push.exitCode = 0;
            } catch (error) {
              const stdout = (error as { stdout?: string }).stdout ?? "";
              await durableJson(log, { error: String(error), stdout });
              const code = (error as { code?: unknown }).code;
              repo.push.exitCode = typeof code === "number" ? code : null;
              if (/^!\t.*\[(?:remote )?rejected\]/mu.test(stdout)) repo.push.state = "rejected";
            }
            if (repo.push.state !== "rejected") repo.push.state = "unconfirmed";
            await this.save(recorded);
            const landed = (await this.git(repo.directory, ["ls-remote", "origin", "refs/heads/main"])).split(
              /\s/u,
            )[0];
            if (landed !== repo.head)
              throw Error(`${repo.name}: push ${repo.push.state}; no automatic retry (see ${log})`);
            repo.push.state = "confirmed";
            repo.ownerCheckoutSync = await syncOwnerCheckout(repo.source);
            await this.save(recorded);
          }
          recorded.state = "pushed";
          await this.save(recorded);
          return recorded;
        } catch (error) {
          if (error instanceof GateNotCovering) onUncovered?.();
          // Keep successful/uncertain individual repo landings; two origins have no atomic transaction.
          const latest = await this.stored(id);
          latest.state = latest.repos.some((r) => r.push) ? "partial" : "held";
          const core = latest.repos.find((r) => r.name === "core");
          const app = latest.repos.find((r) => r.name === "app");
          latest.error =
            core?.push?.state === "confirmed" && app?.push?.state !== "confirmed"
              ? `Core landed at ${core.head}; app pending. ${String(error)}`
              : String(error);
          await this.save(latest);
          return latest;
        }
      });
    } finally {
      if (!wasRunning) {
        this.running.delete(id);
        await this.reclaimWorktrees().catch((error) => console.warn("Integration cleanup deferred", error));
      }
    }
  }
}
