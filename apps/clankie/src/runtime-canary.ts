import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { z } from "zod";
import {
  readRuntimeUpdate,
  type RuntimeBootIdentity,
  type RuntimeCanaryResult,
  type RuntimeUpdateResult,
} from "../../tui/bin/runtime-update.ts";
import { object, operationId, privateDirectory, readPrivateJson } from "../../tui/bin/update-files.ts";
import { DeployHolds, durableJson, withDirectoryLock } from "./deploy-holds.ts";
import {
  RuntimeHealthSampleSchema,
  RuntimeIdentityMismatch,
  runtimeIdentityMismatch,
  type RuntimeHealthSample,
} from "./runtime-health-sample.ts";
import { DeployHoldSchema, RUNTIME_CANARY_HOLDER, type DeployHold } from "@clankie/protocol/integrate";

export const RuntimeCanaryPolicySchema = z
  .strictObject({
    windowMs: z.number().int().min(1000).max(86_400_000).default(300_000),
    sampleIntervalMs: z.number().int().min(50).max(60_000).default(10_000),
    /** Advisory only: reported beside the previous runtime's mean, never a deploy hold. */
    cpuPercent: z.number().finite().positive().max(10_000).default(10),
    healthLatencyMs: z.number().finite().positive().max(60_000).default(250),
  })
  .refine(
    (policy) => policy.windowMs >= policy.sampleIntervalMs * 2,
    "Window needs at least two sample intervals",
  )
  .refine(
    (policy) => policy.windowMs / policy.sampleIntervalMs <= 3600,
    "Canary sample count exceeds its bound",
  );
export type RuntimeCanaryPolicy = z.infer<typeof RuntimeCanaryPolicySchema>;

/** CPU is machine- and workload-specific, so it is compared with the previous runtime here, not gated. */
export interface RuntimeCanaryCpu {
  readonly commit: string;
  readonly cpuMeanPercent?: number;
  readonly advisoryPercent: number;
  readonly aboveAdvisory?: boolean;
  readonly previous?: { readonly commit: string; readonly cpuMeanPercent: number; readonly updateId: string };
  readonly ratioToPrevious?: number;
}

export { RUNTIME_CANARY_HOLDER };
const HOLDER = RUNTIME_CANARY_HOLDER;
const CheckpointSchema = z.strictObject({ commit: z.string().regex(/^[a-f0-9]{40,64}$/u) });
const ArmSchema = z.strictObject({
  policy: RuntimeCanaryPolicySchema,
  previousHealthyCommit: CheckpointSchema.shape.commit,
});

interface Session {
  readonly id: string;
  readonly policy: RuntimeCanaryPolicy;
  readonly startedAt: number;
  readonly latencies: number[];
  cpuTotal: number;
  cpuDurationMs: number;
  lastSampleAt?: number;
  unavailableSince?: number;
}

// Persist local check names and transport codes, never response bodies or arbitrary error payloads.
function sampleFailure(error: unknown): string {
  if (error instanceof RuntimeIdentityMismatch) return error.diagnostic;
  if (error instanceof z.ZodError)
    return `invalid-health-sample (${error.issues.map((issue) => `${issue.path.join(".")}: ${issue.code}`).join(", ")})`.slice(
      0,
      900,
    );
  if (!(error instanceof Error)) return "unknown-sampling-error";
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
    const code = "code" in current && typeof current.code === "string" ? current.code : undefined;
    const name = /^runtime-(?:health|canary)-[a-z-]+$/u.test(current.message)
      ? current.message
      : ["Error", "AbortError", "TimeoutError", "SyntaxError", "TypeError", "RangeError"].includes(
            current.name,
          )
        ? current.name
        : "Error";
    parts.push(`${name}${code && /^[A-Z_0-9]+$/u.test(code) ? ` (${code})` : ""}`);
    current = current.cause;
  }
  return parts.join(" <- ").slice(0, 900);
}

/** Survives a service restart through private operation records and the existing deploy holds. */
export class RuntimeCanary {
  private readonly options: {
    updatesDirectory: string;
    runtime: RuntimeBootIdentity;
    holds: DeployHolds;
    sample: (runtime: RuntimeBootIdentity) => Promise<RuntimeHealthSample>;
    /** Monotonic elapsed time; defaults to the process clock. */
    now?: () => number;
    alert?: (text: string) => Promise<boolean>;
    onError?: (error: unknown) => void;
    /** Best-effort retention after the passed canary's hold release is durable. */
    onPassed?: () => Promise<void>;
  };
  private readonly now: () => number;
  private session: Session | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private closed = false;
  // Keep completed callbacks for this boot; recovery in a new process runs cleanup again.
  private readonly passedMaintenance = new Map<string, Promise<void>>();

  constructor(options: RuntimeCanary["options"]) {
    this.options = options;
    this.now = options.now ?? (() => performance.now());
  }

  policy(): RuntimeCanaryPolicy {
    const path = join(this.options.updatesDirectory, "canary-policy.json");
    return RuntimeCanaryPolicySchema.parse(existsSync(path) ? readPrivateJson(path) : {});
  }

  async configure(input: unknown, guard: () => Promise<void>): Promise<RuntimeCanaryPolicy> {
    mkdirSync(this.options.updatesDirectory, { recursive: true, mode: 0o700 });
    privateDirectory(this.options.updatesDirectory);
    return withDirectoryLock(join(this.options.updatesDirectory, "canary-policy.lock"), async () => {
      await guard();
      const policy = RuntimeCanaryPolicySchema.parse({ ...this.policy(), ...object(input) });
      await durableJson(join(this.options.updatesDirectory, "canary-policy.json"), policy, guard);
      return policy;
    });
  }

  status(): RuntimeCanaryResult | undefined {
    return this.latest()?.canary;
  }

  /** Read-time comparison; older readers never see new fields in the durable canary record. */
  cpu(): RuntimeCanaryCpu | undefined {
    const result = this.latest();
    if (!result?.canary) return undefined;
    const advisoryPercent = result.canary.policy?.cpuPercent ?? this.policy().cpuPercent;
    const current = result.canary.cpuMeanPercent;
    let previous: RuntimeCanaryCpu["previous"];
    let previousAt = -Infinity;
    for (const entry of readdirSync(this.options.updatesDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === result.id) continue;
      let candidate: RuntimeUpdateResult;
      try {
        candidate = readRuntimeUpdate(join(this.options.updatesDirectory, entry.name));
      } catch {
        continue;
      }
      const mean = candidate.canary?.cpuMeanPercent;
      const at = Date.parse(candidate.updatedAt);
      if (
        candidate.newCommit !== result.oldCommit ||
        mean === undefined ||
        candidate.canary?.state === "pending" ||
        at <= previousAt
      )
        continue;
      previous = { commit: candidate.newCommit, cpuMeanPercent: mean, updateId: candidate.id };
      previousAt = at;
    }
    return {
      commit: result.newCommit,
      advisoryPercent,
      ...(current === undefined ? {} : { cpuMeanPercent: current, aboveAdvisory: current > advisoryPercent }),
      ...(previous === undefined ? {} : { previous }),
      ...(current === undefined || previous === undefined || previous.cpuMeanPercent <= 0
        ? {}
        : { ratioToPrevious: current / previous.cpuMeanPercent }),
    };
  }

  describeHolds(holds: DeployHold[]) {
    return holds.map((hold) => {
      try {
        const result = readRuntimeUpdate(join(this.options.updatesDirectory, operationId(hold.id)));
        const wanted = this.hold(result, this.previousHealthy(result));
        if (
          result.id === hold.id &&
          hold.holder === wanted.holder &&
          hold.reason === wanted.reason &&
          !hold.pane &&
          !hold.seat
        )
          return { ...hold, candidate: result.newCommit, canary: result.canary };
      } catch {
        // Missing or unreadable provenance stays a blocking hold, with its original reason.
      }
      return hold;
    });
  }

  private latest(): RuntimeUpdateResult | undefined {
    const path = join(this.options.updatesDirectory, "latest.json");
    if (!existsSync(path)) return undefined;
    const id = operationId(object(readPrivateJson(path)).id);
    const result = readRuntimeUpdate(join(this.options.updatesDirectory, id));
    if (result.id !== id) throw Error("Runtime canary update identity changed");
    return result;
  }

  private previousHealthy(result: RuntimeUpdateResult): string {
    if (result.canary?.previousHealthyCommit) return result.canary.previousHealthyCommit;
    const path = join(this.options.updatesDirectory, "healthy-canary.json");
    if (existsSync(path)) {
      const checkpoint = CheckpointSchema.parse(readPrivateJson(path));
      return checkpoint.commit;
    }
    return result.oldCommit;
  }

  private hold(result: RuntimeUpdateResult, previous: string) {
    return {
      id: result.id,
      holder: HOLDER,
      reason: `Runtime canary for ${result.newCommit}; previous healthy ${previous}`,
    };
  }

  private async ensureHold(result: RuntimeUpdateResult, previous: string): Promise<void> {
    const wanted = this.hold(result, previous);
    const existing = (await this.options.holds.list()).find((hold) => hold.id === wanted.id);
    if (existing) {
      if (
        existing.holder !== wanted.holder ||
        existing.reason !== wanted.reason ||
        existing.pane ||
        existing.seat
      )
        throw Error("Runtime canary hold ownership changed");
      return;
    }
    await this.options.holds.acquire(wanted);
  }

  private async save(result: RuntimeUpdateResult, canary: RuntimeCanaryResult): Promise<RuntimeUpdateResult> {
    const directory = join(this.options.updatesDirectory, result.id);
    const current = readRuntimeUpdate(directory);
    if (current.id !== result.id || current.newCommit !== result.newCommit || current.phase !== "healthy")
      throw Error("Runtime canary update result changed");
    const next = { ...current, canary, updatedAt: new Date().toISOString() };
    await durableJson(join(directory, "result.json"), next);
    return next;
  }

  /** Acquire before exposing deployment admission; /health itself must remain available during restart. */
  async recover(): Promise<void> {
    const result = this.latest();
    if (!result) return;
    if (["rolled-back", "failed", "stop-unconfirmed"].includes(result.phase)) {
      await this.releasePrehealthyRollback(result);
      return;
    }
    if (result.phase === "restarting" && result.newCommit === this.options.runtime.commit) {
      await this.arm(result);
      return;
    }
    if (result.phase !== "healthy") return;
    if (result.canary?.state === "passed") {
      await this.releasePassed(result);
      return;
    }
    // latest.json is shared with old/foreign runtimes. Only the candidate commit
    // can recover its observation; a different observer is not a replacement sample.
    if (result.newCommit !== this.options.runtime.commit) {
      // A live (or unproven) armed process may still be observing this candidate.
      // Only a confirmed exit permits this boot to fail its interrupted window.
      if (result.canary?.state !== "pending" || !this.candidateExited(result.canary.pid)) return;
      // Startup recovery precedes HTTP admission. Defer until this boot really
      // serves healthy HTTP; a stale observer cannot infer replacement from its
      // own commit or a vanished PID alone.
      try {
        const sample = RuntimeHealthSampleSchema.parse(await this.options.sample(this.options.runtime));
        if (runtimeIdentityMismatch("runtime-canary-runtime-changed", this.options.runtime, sample.runtime))
          return;
      } catch {
        return;
      }
      if (this.closed) return;
      const current = this.latest();
      if (
        current?.id !== result.id ||
        current.phase !== "healthy" ||
        current.newCommit !== result.newCommit ||
        current.canary?.state !== "pending" ||
        current.canary.pid !== result.canary.pid ||
        current.canary.instanceId !== result.canary.instanceId
      )
        return;
      const armed = await this.arm(result);
      const mismatch = new RuntimeIdentityMismatch(
        "runtime-canary-runtime-changed",
        "commit",
        result.newCommit,
        this.options.runtime.commit,
      );
      await this.fail(result, { ...result.canary, ...armed }, mismatch.diagnostic);
      return;
    }
    if (result.canary?.state === "failed") {
      if (result.canary.holdEstablished !== true) {
        await this.ensureHold(result, this.previousHealthy(result));
        await this.save(result, { ...result.canary, holdId: result.id, holdEstablished: true });
      }
      return;
    }
    const armed = await this.arm(result);
    this.session = {
      id: result.id,
      policy: armed.policy,
      startedAt: this.now(),
      latencies: [],
      cpuTotal: 0,
      cpuDurationMs: 0,
    };
    await this.save(result, {
      state: "pending",
      ...armed,
      holdId: result.id,
      holdEstablished: true,
      instanceId: this.options.runtime.instanceId,
      pid: this.options.runtime.pid,
      startedAt: new Date().toISOString(),
      samples: 0,
    });
  }

  private candidateExited(pid: number | undefined): boolean {
    if (pid === undefined) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      // Permission failures and PID reuse cannot prove a candidate's exit.
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  }

  private async arm(result: RuntimeUpdateResult): Promise<z.infer<typeof ArmSchema>> {
    const path = join(this.options.updatesDirectory, result.id, "canary-policy.json");
    const armed = existsSync(path)
      ? ArmSchema.parse(readPrivateJson(path))
      : ArmSchema.parse({
          policy: result.canary?.policy ?? this.policy(),
          previousHealthyCommit: this.previousHealthy(result),
        });
    await this.ensureHold(result, armed.previousHealthyCommit);
    if (!existsSync(path)) await durableJson(path, armed);
    return armed;
  }

  start(): void {
    if (this.timer || this.running || this.closed) return;
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.tick()
        .catch((error: unknown) => this.options.onError?.(error))
        .finally(() => {
          this.running = undefined;
          if (!this.closed) {
            let intervalMs = this.session?.policy.sampleIntervalMs ?? 10_000;
            try {
              intervalMs = this.session?.policy.sampleIntervalMs ?? this.policy().sampleIntervalMs;
            } catch (error) {
              this.options.onError?.(error);
            }
            this.schedule(intervalMs);
          }
        });
    }, delay);
    this.timer.unref();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private async tick(): Promise<void> {
    let result = this.latest();
    if (result !== undefined && ["rolled-back", "failed", "stop-unconfirmed"].includes(result.phase)) {
      await this.releasePrehealthyRollback(result);
      return;
    }
    if (!result || result.phase !== "healthy") return;
    if (result.newCommit !== this.options.runtime.commit) {
      if (result.canary?.state === "pending") await this.recover();
      return;
    }
    if (result.canary?.state === "failed") {
      await this.notify(result);
      return;
    }
    if (result.canary?.state === "passed") {
      await this.releasePassed(result);
      return;
    }
    if (!this.session || this.session.id !== result.id) {
      await this.recover();
      result = this.latest();
    }
    const session = this.session;
    if (!session || !result?.canary || result.canary.state !== "pending") return;
    let sample: RuntimeHealthSample;
    const attemptStartedAt = this.now();
    try {
      sample = RuntimeHealthSampleSchema.parse(await this.options.sample(this.options.runtime));
      const mismatch = runtimeIdentityMismatch(
        "runtime-canary-runtime-changed",
        this.options.runtime,
        sample.runtime,
      );
      if (mismatch) throw mismatch;
      if (
        Math.abs(Date.now() - Date.parse(sample.observedAt)) >
        Math.max(5000, session.policy.sampleIntervalMs * 2)
      )
        throw Error("runtime-canary-sample-stale");
    } catch (error) {
      if (this.closed) return;
      session.unavailableSince ??= session.lastSampleAt ?? attemptStartedAt;
      const now = this.now();
      const diagnostic = `runtime-canary-health-unavailable: ${sampleFailure(error)}`;
      // Keep the existing three-interval availability budget, but allow transient misses to recover.
      // A completely unavailable first observation is bounded by the full window as well.
      if (
        now - session.unavailableSince >= session.policy.sampleIntervalMs * 3 ||
        now - session.startedAt >= session.policy.windowMs
      )
        await this.fail(result, result.canary, diagnostic);
      else await this.save(result, { ...result.canary, error: diagnostic });
      return;
    }
    if (this.closed) return;
    const now = this.now();
    const lastVerifiedAt = session.lastSampleAt ?? session.unavailableSince;
    if (lastVerifiedAt !== undefined && now - lastVerifiedAt >= session.policy.sampleIntervalMs * 3) {
      await this.fail(
        result,
        result.canary,
        `runtime-canary-sampling-gap: ${Math.round(now - lastVerifiedAt)}ms without verified health (budget ${session.policy.sampleIntervalMs * 3}ms)${result.canary.error ? `; last failure ${result.canary.error}` : ""}`.slice(
          0,
          1024,
        ),
      );
      return;
    }
    delete session.unavailableSince;
    session.lastSampleAt = now;
    session.latencies.push(sample.healthLatencyMs);
    session.cpuTotal += sample.cpuPercent * sample.intervalMs;
    session.cpuDurationMs += sample.intervalMs;
    const sorted = [...session.latencies].sort((a, b) => a - b);
    const healthP95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    const cpuMeanPercent = session.cpuTotal / session.cpuDurationMs;
    const canary = {
      ...result.canary,
      samples: session.latencies.length,
      cpuMeanPercent,
      healthP95Ms,
    };
    delete canary.error;
    if (now - session.startedAt < session.policy.windowMs) {
      await this.save(result, canary);
      return;
    }
    // CPU is recorded for comparison only; holds are for a new service that is not healthy.
    if (session.latencies.length < 2) {
      await this.fail(result, canary, "runtime-canary-samples-incomplete");
    } else if (healthP95Ms > session.policy.healthLatencyMs) {
      await this.fail(result, canary, "runtime-canary-latency-budget-exceeded");
    } else {
      const passed = await this.save(result, {
        ...canary,
        state: "passed",
        completedAt: new Date().toISOString(),
      });
      await this.releasePassed(passed);
    }
    this.session = undefined;
  }

  private async fail(result: RuntimeUpdateResult, canary: RuntimeCanaryResult, error: string): Promise<void> {
    const previousHealthyCommit = canary.previousHealthyCommit ?? this.previousHealthy(result);
    await this.ensureHold(result, previousHealthyCommit);
    const failed = await this.save(result, {
      ...canary,
      state: "failed",
      holdId: result.id,
      holdEstablished: true,
      previousHealthyCommit,
      completedAt: new Date().toISOString(),
      error,
      alertState: "pending",
    });
    this.session = undefined;
    await this.notify(failed);
  }

  private async notify(result: RuntimeUpdateResult): Promise<void> {
    if (!result.canary || (result.canary.alertState !== undefined && result.canary.alertState !== "pending"))
      return;
    const claimed = { ...result.canary, alertState: "claimed" as const };
    // A crash after this claim leaves delivery unknown. It must never replay an uncertain notification.
    await this.save(result, claimed);
    let submitted = false;
    try {
      submitted =
        (await this.options.alert?.(
          `Runtime canary held further deploys for ${result.newCommit}: ${claimed.error ?? "health unavailable"}. Previous healthy commit: ${claimed.previousHealthyCommit ?? result.oldCommit}. CPU mean ${claimed.cpuMeanPercent?.toFixed(2) ?? "unavailable"}% (one core); health p95 ${claimed.healthP95Ms?.toFixed(2) ?? "unavailable"}ms. No automatic rollback; inspect update status and the retained previous runtime.`,
        )) === true;
    } catch {
      // Alert transport failure does not remove a durable deployment hold.
    }
    // Acceptance by the native notification path does not confirm receipt.
    await this.save(result, { ...claimed, alertState: submitted ? "submitted" : "unavailable" });
  }

  private async releasePassed(result: RuntimeUpdateResult): Promise<void> {
    if (!result.canary || result.canary.state !== "passed") return;
    if (result.newCommit !== this.options.runtime.commit)
      throw Error("Passed runtime canary does not match the running commit");
    const wanted = this.hold(result, this.previousHealthy(result));
    const existing = (await this.options.holds.list()).find((hold) => hold.id === wanted.id);
    if (existing) {
      if (
        existing.holder !== wanted.holder ||
        existing.reason !== wanted.reason ||
        existing.pane ||
        existing.seat
      )
        throw Error("Runtime canary hold ownership changed");
      await this.options.holds.release(
        wanted.id,
        HOLDER,
        "Runtime canary passed its full health and latency window",
        existing,
      );
    }
    // Retry on recovery even when this canary released its own hold before the process exited.
    await this.releaseSuperseded(result);
    if (result.canary.holdReleased !== true) {
      await durableJson(join(this.options.updatesDirectory, "healthy-canary.json"), {
        commit: result.newCommit,
      });
      await this.save(result, { ...result.canary, holdReleased: true });
    }
    if (this.options.onPassed) {
      let maintenance = this.passedMaintenance.get(result.id);
      if (!maintenance) {
        maintenance = Promise.resolve()
          .then(() => this.options.onPassed!())
          .catch((error) => {
            this.passedMaintenance.delete(result.id);
            this.options.onError?.(error);
          });
        this.passedMaintenance.set(result.id, maintenance);
      }
      await maintenance;
    }
  }

  private async releaseSuperseded(passed: RuntimeUpdateResult): Promise<void> {
    const overridePath = join(this.options.updatesDirectory, passed.id, "overridden-holds.json");
    // An unreadable admitted override snapshot is uncertainty, never authority to remove a hold.
    const overridden = existsSync(overridePath)
      ? z.array(DeployHoldSchema).parse(readPrivateJson(overridePath))
      : [];
    const records: RuntimeUpdateResult[] = [];
    const startedAt = Date.parse(passed.canary?.startedAt ?? passed.updatedAt);
    for (const entry of readdirSync(this.options.updatesDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === passed.id) continue;
      try {
        const candidate = readRuntimeUpdate(join(this.options.updatesDirectory, operationId(entry.name)));
        if (
          candidate.id === entry.name &&
          candidate.phase === "healthy" &&
          Date.parse(candidate.updatedAt) <= startedAt
        )
          records.push(candidate);
      } catch {
        // Missing or unreadable provenance cannot authorize a release.
      }
    }
    // Walk the actual installed-runtime chain, rather than treating every old hold as superseded.
    const commits = new Set([passed.newCommit, passed.oldCommit]);
    let size: number;
    do {
      size = commits.size;
      for (const record of records) if (commits.has(record.newCommit)) commits.add(record.oldCommit);
    } while (commits.size !== size);
    for (const existing of await this.options.holds.list()) {
      if (
        existing.id === passed.id ||
        existing.holder !== HOLDER ||
        existing.pane ||
        existing.seat ||
        Date.parse(existing.createdAt) > startedAt
      )
        continue;
      const record = records.find((candidate) => candidate.id === existing.id);
      if (!record?.canary) continue;
      const wanted = this.hold(record, this.previousHealthy(record));
      if (existing.reason !== wanted.reason) continue;
      const admitted = overridden.some(
        (hold) =>
          hold.id === existing.id &&
          hold.holder === existing.holder &&
          hold.reason === existing.reason &&
          hold.createdAt === existing.createdAt &&
          !hold.pane &&
          !hold.seat,
      );
      if (!admitted && !commits.has(record.newCommit)) continue;
      await this.options.holds.release(
        existing.id,
        HOLDER,
        `Runtime canary ${passed.id} passed and superseded this observation`,
        existing,
      );
    }
  }

  private async releasePrehealthyRollback(result: RuntimeUpdateResult): Promise<void> {
    // A confirmed rollback, or an uncertain ending this running runtime reconciled.
    const restored = result.rollbackHealthy === true && result.oldCommit === this.options.runtime.commit;
    const reconciled = result.reconciled?.commit === this.options.runtime.commit;
    if ((!restored && !reconciled) || result.canary?.state === "failed" || result.canary?.state === "passed")
      return;
    const path = join(this.options.updatesDirectory, result.id, "canary-policy.json");
    if (!existsSync(path)) return;
    const armed = ArmSchema.parse(readPrivateJson(path));
    const wanted = this.hold(result, armed.previousHealthyCommit);
    const existing = (await this.options.holds.list()).find((hold) => hold.id === wanted.id);
    if (
      !existing ||
      existing.holder !== wanted.holder ||
      existing.reason !== wanted.reason ||
      existing.pane ||
      existing.seat
    )
      return;
    // No canary began: the helper restored its old runtime, or the service reconciled the ending.
    await this.options.holds.release(
      wanted.id,
      HOLDER,
      restored
        ? "Pre-canary cutover restored its confirmed previous runtime"
        : "Pre-canary cutover ended uncertain and this runtime reconciled it",
      wanted,
    );
  }
}
