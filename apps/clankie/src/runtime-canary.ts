import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { z } from "zod";
import {
  readRuntimeUpdate,
  runtimeRollbackRef,
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
const UnconfirmedAlertSchema = z.enum(["claimed", "submitted", "unavailable"]);
// Sidecar metadata keeps result.json readable by retained older runtimes during rollback.
const PressureSchema = z.strictObject({
  state: z.enum(["busy", "clear", "unavailable"]),
  load1: z.number().finite().nonnegative().optional(),
  load15: z.number().finite().nonnegative().optional(),
  cores: z.number().int().positive().optional(),
  externalLoadRatio: z.number().finite().nonnegative().optional(),
  externalCpuRatio: z.number().finite().nonnegative().optional(),
  cpuPercent: z.number().finite().nonnegative().optional(),
  healthLatencyMs: z.number().finite().nonnegative().optional(),
  observedAt: z.iso.datetime(),
});
const MAX_EXTERNAL_LOAD_RATIO = 0.5;
const ExtensionSchema = z.strictObject({ extended: z.literal(true) });
const ArmSchema = z.strictObject({
  policy: RuntimeCanaryPolicySchema,
  previousHealthyCommit: CheckpointSchema.shape.commit,
});

/**
 * One health probe of the current window. A probe that missed under pressure is
 * kept as an over-budget latency (Infinity), so misses count against the p95.
 */
interface Observation {
  readonly latencyMs: number;
  readonly cpuPercent?: number;
  readonly intervalMs: number;
  readonly pressured: boolean;
}

interface Session {
  readonly id: string;
  readonly policy: RuntimeCanaryPolicy;
  startedAt: number;
  /** Windows are judged fresh, one after another, never as overlapping slices. */
  windowStartedAt: number;
  observations: Observation[];
  /** Set once an over-budget window under pressure extended the observation. */
  extended?: boolean;
  /** Consecutive windows within budget since the extension began. */
  passingWindows: number;
  lastMiss?: string;
  lastCpuPercent?: number;
  lastSampleAt?: number;
  unavailableSince?: number;
}

/**
 * Host pressure can only inflate the runtime's own latency, so it never discards
 * evidence or delays a pass. It only extends a failing verdict, by at most this
 * long past the first window, so a busy machine can never hold a canary forever.
 */
export function runtimeCanaryDecisionMs(policy: RuntimeCanaryPolicy): number {
  return policy.windowMs + Math.min(policy.windowMs * 5, 3_600_000);
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
    /** Host observations are independent of the candidate health endpoint. */
    pressure?: () => { load1: number; load15: number; cores: number; cpuRatio?: number };
    alert?: (text: string, conversationId?: string) => Promise<boolean>;
    onError?: (error: unknown) => void;
    /** Best-effort retention after the passed canary's hold release is durable. */
    onPassed?: () => Promise<void>;
  };
  private readonly now: () => number;
  private session: Session | undefined;
  private cpuWindow: { at: number; busy: number; total: number; ratio?: number } | undefined;
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
    const result = this.latest();
    if (!result?.canary) return undefined;
    const path = join(this.options.updatesDirectory, result.id, "canary-pressure.json");
    const pressure = existsSync(path) ? PressureSchema.parse(readPrivateJson(path)) : undefined;
    return {
      ...result.canary,
      ...(pressure
        ? {
            pressure: {
              state: pressure.state,
              observedAt: pressure.observedAt,
              ...(pressure.load1 !== undefined ? { load1: pressure.load1 } : {}),
              ...(pressure.load15 !== undefined ? { load15: pressure.load15 } : {}),
              ...(pressure.cores !== undefined ? { cores: pressure.cores } : {}),
              ...(pressure.externalLoadRatio !== undefined
                ? { externalLoadRatio: pressure.externalLoadRatio }
                : {}),
              ...(pressure.externalCpuRatio !== undefined
                ? { externalCpuRatio: pressure.externalCpuRatio }
                : {}),
              ...(pressure.cpuPercent !== undefined ? { cpuPercent: pressure.cpuPercent } : {}),
              ...(pressure.healthLatencyMs !== undefined
                ? { healthLatencyMs: pressure.healthLatencyMs }
                : {}),
            },
          }
        : {}),
    };
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
          return {
            ...hold,
            candidate: result.newCommit,
            canary: result.id === this.latest()?.id ? this.status() : result.canary,
          };
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
      await this.alertUnconfirmed(result);
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
    const startedAt = this.now();
    // New-runtime sidecar: a restart mid-extension still needs two windows in a row.
    // A restart begins a fresh observation, and with it a fresh decision bound.
    const extensionPath = join(this.options.updatesDirectory, result.id, "canary-extension.json");
    this.session = {
      id: result.id,
      policy: armed.policy,
      startedAt,
      windowStartedAt: startedAt,
      observations: [],
      passingWindows: 0,
      ...(existsSync(extensionPath) && ExtensionSchema.safeParse(readPrivateJson(extensionPath)).success
        ? { extended: true }
        : {}),
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

  private hostPressure(): { load1: number; load15: number; cores: number; cpuRatio?: number } {
    const cores = cpus();
    let busy = 0,
      total = 0;
    for (const { times } of cores) {
      const used = times.user + times.nice + times.sys + times.irq;
      busy += used;
      total += used + times.idle;
    }
    const at = performance.now();
    if (!this.cpuWindow) this.cpuWindow = { at, busy, total };
    else if (at - this.cpuWindow.at >= 250) {
      const elapsedTicks = total - this.cpuWindow.total;
      if (!(elapsedTicks > 0)) throw Error("CPU ticks unavailable");
      const ratio = Math.min(1, Math.max(0, (busy - this.cpuWindow.busy) / elapsedTicks));
      this.cpuWindow = { at, busy, total, ratio };
    }
    return {
      load1: loadavg()[0]!,
      load15: loadavg()[2]!,
      cores: cores.length,
      ...(this.cpuWindow.ratio === undefined ? {} : { cpuRatio: this.cpuWindow.ratio }),
    };
  }

  private pressure(cpuPercent = 0): z.infer<typeof PressureSchema> {
    try {
      const host = this.options.pressure?.() ?? this.hostPressure();
      if (
        ![host.load1, host.load15, host.cores].every(Number.isFinite) ||
        host.load1 < 0 ||
        host.load15 < 0 ||
        (host.cpuRatio !== undefined &&
          (!Number.isFinite(host.cpuRatio) || host.cpuRatio < 0 || host.cpuRatio > 1)) ||
        !Number.isSafeInteger(host.cores) ||
        host.cores < 1
      )
        throw Error("Invalid host load observation");
      // Load is runnable cores, while service CPU is percent of ONE core. Remove
      // the candidate's own contribution so its CPU regression cannot defer itself.
      const externalLoadRatio =
        Math.max(0, Math.max(host.load1, host.load15) - cpuPercent / 100) / host.cores;
      const externalCpuRatio =
        host.cpuRatio === undefined
          ? undefined
          : Math.max(0, host.cpuRatio - cpuPercent / (100 * host.cores));
      return {
        load1: host.load1,
        load15: host.load15,
        cores: host.cores,
        externalLoadRatio,
        ...(externalCpuRatio === undefined ? {} : { externalCpuRatio }),
        state: (externalCpuRatio ?? externalLoadRatio) > MAX_EXTERNAL_LOAD_RATIO ? "busy" : "clear",
        observedAt: new Date().toISOString(),
      };
    } catch {
      return { state: "unavailable", observedAt: new Date().toISOString() };
    }
  }

  /** One stable notice when load first extends a verdict; definite non-delivery retries the same text. */
  private async noticeExtension(
    result: RuntimeUpdateResult,
    canary: RuntimeCanaryResult,
    pressure: z.infer<typeof PressureSchema>,
    deadline: string,
  ): Promise<void> {
    const pending = await this.save(result, canary);
    const noticePath = join(this.options.updatesDirectory, result.id, "canary-pressure-alert.json");
    if (!existsSync(noticePath))
      await durableJson(
        noticePath,
        `Runtime canary is extending its window for ${result.newCommit} while the machine is busy: ${canary.error}. Load 1m ${pressure.load1?.toFixed(2) ?? "unavailable"}, 15m ${pressure.load15?.toFixed(2) ?? "unavailable"} on ${pressure.cores ?? "unknown"} cores; external load ratio ${pressure.externalLoadRatio?.toFixed(2) ?? "unavailable"}, external CPU ratio ${pressure.externalCpuRatio?.toFixed(2) ?? "unavailable"} (quiet budget ${MAX_EXTERNAL_LOAD_RATIO}). Once extended it passes on two windows in a row within budget, and otherwise holds by ${deadline}. ${this.commands(result)}`,
      );
    await this.notify(pending, z.string().min(1).max(4000).parse(readPrivateJson(noticePath)));
  }

  private commands(result: RuntimeUpdateResult): string {
    return `No automatic rollback. Inspect: clankie update status. Release after review: clankie integrate release ${result.id} --actor Clankie --reason "reviewed runtime health". Roll back as owner: clankie update --ref ${runtimeRollbackRef(result)} --override-holds --reason "rollback failed canary ${result.id}".`;
  }

  private async tick(): Promise<void> {
    let result = this.latest();
    if (result !== undefined && ["rolled-back", "failed", "stop-unconfirmed"].includes(result.phase)) {
      await this.releasePrehealthyRollback(result);
      await this.alertUnconfirmed(result);
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
    const before = this.pressure(session.lastCpuPercent ?? result.canary.cpuMeanPercent);
    const pressurePath = join(this.options.updatesDirectory, result.id, "canary-pressure.json");
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
      const pressure = this.pressure(session.lastCpuPercent ?? result.canary.cpuMeanPercent);
      await durableJson(pressurePath, pressure);
      const diagnostic = `runtime-canary-health-unavailable: ${sampleFailure(error)}`;
      // Wrong identity, invalid HTTP, and invalid metadata remain regressions under load.
      // Only transport misses can be explained by a pressured scheduler.
      const transportMiss =
        error instanceof Error &&
        !(error instanceof RuntimeIdentityMismatch) &&
        !(error instanceof z.ZodError) &&
        !error.message.startsWith("runtime-health-");
      const busy = before.state !== "clear" ? before : pressure.state !== "clear" ? pressure : undefined;
      if (transportMiss && busy) {
        // The canary ran; the miss counts against this window's p95 as an over-budget probe.
        session.observations.push({ latencyMs: Infinity, intervalMs: 0, pressured: true });
        session.lastMiss = diagnostic;
        session.lastSampleAt = this.now();
        await this.judge(result, session, busy);
        return;
      }
      session.unavailableSince ??= session.lastSampleAt ?? attemptStartedAt;
      const now = this.now();
      // Keep the existing three-interval availability budget, but allow transient misses to recover.
      // Unhealthy, wrong-identity or invalid health after the first window fails at once, as before;
      // a quiet transport miss keeps the three-interval budget even during an extension.
      if (
        now - session.unavailableSince >= session.policy.sampleIntervalMs * 3 ||
        (now - session.startedAt >= session.policy.windowMs && (!transportMiss || !session.extended))
      )
        await this.fail(result, result.canary, diagnostic);
      else await this.save(result, { ...result.canary, error: diagnostic });
      return;
    }
    if (this.closed) return;
    const now = this.now();
    session.lastCpuPercent = sample.cpuPercent;
    const after = this.pressure(sample.cpuPercent);
    const pressure = {
      ...(before.state !== "clear" ? before : after),
      cpuPercent: sample.cpuPercent,
      healthLatencyMs: sample.healthLatencyMs,
    };
    await durableJson(pressurePath, pressure);
    const lastVerifiedAt = session.lastSampleAt ?? session.unavailableSince;
    const gap = lastVerifiedAt !== undefined && now - lastVerifiedAt >= session.policy.sampleIntervalMs * 3;
    // A pressured scheduler may stall the canary itself: count the gap as one over-budget probe.
    if (gap && pressure.state !== "clear")
      session.observations.push({ latencyMs: Infinity, intervalMs: 0, pressured: true });
    else if (gap) {
      await this.fail(
        result,
        result.canary,
        `runtime-canary-sampling-gap: ${Math.round(now - lastVerifiedAt!)}ms without verified health (budget ${session.policy.sampleIntervalMs * 3}ms)${result.canary.error ? `; last failure ${result.canary.error}` : ""}`.slice(
          0,
          1024,
        ),
      );
      return;
    }
    delete session.unavailableSince;
    session.lastSampleAt = now;
    session.observations.push({
      latencyMs: sample.healthLatencyMs,
      cpuPercent: sample.cpuPercent,
      intervalMs: sample.intervalMs,
      pressured: pressure.state !== "clear",
    });
    await this.judge(result, session, pressure);
  }

  /**
   * Judge fresh, non-overlapping windows. The first window passes within budget
   * however busy the machine was. Over budget with pressure in the window, the
   * observation extends; it then needs two consecutive windows within budget, and
   * fails at the decision bound. Nothing non-finite is persisted.
   */
  private async judge(
    result: RuntimeUpdateResult,
    session: Session,
    pressure: z.infer<typeof PressureSchema>,
  ): Promise<void> {
    const canaryBefore = result.canary!;
    const now = this.now();
    const observations = session.observations;
    const verified = observations.filter((observation) => Number.isFinite(observation.latencyMs));
    const sorted = observations.map((observation) => observation.latencyMs).sort((a, b) => a - b);
    const p95 = sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1]! : Infinity;
    const timed = verified.filter((observation) => observation.intervalMs > 0);
    const cpuDurationMs = timed.reduce((total, observation) => total + observation.intervalMs, 0);
    const canary: RuntimeCanaryResult = {
      ...canaryBefore,
      samples: verified.length,
      ...(cpuDurationMs > 0
        ? {
            cpuMeanPercent:
              timed.reduce(
                (total, observation) => total + observation.cpuPercent! * observation.intervalMs,
                0,
              ) / cpuDurationMs,
          }
        : {}),
      ...(Number.isFinite(p95) ? { healthP95Ms: p95 } : {}),
    };
    if (cpuDurationMs === 0) delete (canary as { cpuMeanPercent?: number }).cpuMeanPercent;
    if (!Number.isFinite(p95)) delete (canary as { healthP95Ms?: number }).healthP95Ms;
    delete (canary as { error?: string }).error;
    const decisionMs = runtimeCanaryDecisionMs(session.policy);
    const deadline = new Date(Date.now() + Math.max(0, session.startedAt + decisionMs - now)).toISOString();
    const progress = (error?: string) =>
      error === undefined ? canary : { ...canary, error: error.slice(0, 1024) };
    if (now - session.windowStartedAt < session.policy.windowMs) {
      const missing = session.lastMiss && !Number.isFinite(observations.at(-1)?.latencyMs ?? 0);
      const note = session.extended
        ? `runtime-canary-extended-under-pressure: judging window ${session.passingWindows + 1} of 2 in a row within budget; deciding by ${deadline}${missing ? `; last probe ${session.lastMiss}` : ""}`
        : missing
          ? `${session.lastMiss} while the machine is busy`
          : undefined;
      // Only an actual extension notifies; the notice path retries a definitely undelivered
      // notice each tick and never replays a claim.
      if (note && session.extended) await this.noticeExtension(result, progress(note), pressure, deadline);
      else await this.save(result, progress(note));
      return;
    }
    // CPU is recorded for comparison only; holds are for a new service that is not healthy.
    const within = verified.length >= 2 && p95 <= session.policy.healthLatencyMs;
    const windowPressured = observations.some((observation) => observation.pressured);
    const nextWindow = () => {
      session.windowStartedAt = now;
      session.observations = [];
      delete session.lastMiss;
    };
    if (within) {
      session.passingWindows += 1;
      if (!session.extended || session.passingWindows >= 2) {
        const passed = await this.save(result, {
          ...canary,
          state: "passed",
          completedAt: new Date().toISOString(),
        });
        await this.releasePassed(passed);
        this.session = undefined;
        return;
      }
    } else session.passingWindows = 0;
    // Another full window fits the bound (allowing half a window of tick drift).
    const room =
      now + session.policy.windowMs <= session.startedAt + decisionMs + session.policy.windowMs / 2;
    if ((within || windowPressured) && room) {
      if (!session.extended)
        await durableJson(join(this.options.updatesDirectory, result.id, "canary-extension.json"), {
          extended: true,
        });
      session.extended = true;
      nextWindow();
      const reason = within
        ? "1 of 2 windows in a row within budget"
        : verified.length < 2
          ? `too few verified samples${session.lastMiss ? ` (${session.lastMiss})` : ""}`
          : Number.isFinite(p95)
            ? `health p95 ${p95.toFixed(2)}ms over budget ${session.policy.healthLatencyMs}ms`
            : `${observations.length - verified.length} of ${observations.length} probes missed`;
      await this.noticeExtension(
        result,
        progress(
          `runtime-canary-extended-under-pressure: ${reason} in a window with machine pressure; deciding by ${deadline}`,
        ),
        pressure,
        deadline,
      );
      return;
    }
    await this.fail(
      result,
      canary,
      verified.length < 2
        ? session.lastMiss
          ? `${session.lastMiss} (under machine pressure through the decision bound)`
          : "runtime-canary-samples-incomplete"
        : within
          ? "runtime-canary-latency-budget-exceeded-under-pressure: two windows in a row within budget were not observed by the decision bound"
          : windowPressured || session.extended
            ? "runtime-canary-latency-budget-exceeded-under-pressure"
            : "runtime-canary-latency-budget-exceeded",
    );
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

  private async notify(result: RuntimeUpdateResult, text?: string): Promise<void> {
    if (
      !result.canary ||
      (result.canary.alertState !== undefined &&
        !["pending", "unavailable"].includes(result.canary.alertState))
    )
      return;
    const claimed = { ...result.canary, alertState: "claimed" as const };
    // A crash after this claim leaves delivery unknown. It must never replay an uncertain notification.
    await this.save(result, claimed);
    let submitted = false;
    try {
      submitted =
        (await this.options.alert?.(
          text ??
            `Runtime canary held further deploys for ${result.newCommit}: ${claimed.error ?? "health unavailable"}. Previous healthy commit: ${claimed.previousHealthyCommit ?? result.oldCommit}. CPU mean ${claimed.cpuMeanPercent?.toFixed(2) ?? "unavailable"}% (one core; advisory ${claimed.policy?.cpuPercent ?? "unavailable"}%); health p95 ${claimed.healthP95Ms?.toFixed(2) ?? "unavailable"}ms (budget ${claimed.policy?.healthLatencyMs ?? "unavailable"}ms). ${this.commands(result)}`,
          result.initiator?.conversationId,
        )) === true;
    } catch {
      // An exception is uncertain: retain the claim, never replay it.
      return;
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

  /**
   * A deploy that stopped services and could not confirm a healthy end may have
   * left them down until someone started them (VUH-2293). The runtime that boots
   * next alerts the initiating conversation, or the owner's, once per update
   * through the runtime-health route; an uncertain delivery is never replayed.
   */
  private async alertUnconfirmed(result: RuntimeUpdateResult): Promise<void> {
    const unconfirmed =
      result.phase === "stop-unconfirmed" ||
      (result.phase === "failed" &&
        result.reason !== "pre-cutover-failed" &&
        result.rollbackHealthy !== true);
    if (!unconfirmed || !this.options.alert) return;
    const path = join(this.options.updatesDirectory, result.id, "unconfirmed-alert.json");
    if (existsSync(path) && UnconfirmedAlertSchema.parse(readPrivateJson(path)) !== "unavailable") return;
    const failures = [
      ...new Set(
        (result.serviceReceipts ?? []).flatMap((receipt) =>
          receipt.services.flatMap((entry) => (entry.ok ? [] : [`${entry.id}: ${entry.error ?? "failed"}`])),
        ),
      ),
    ];
    const text = [
      `Deploy ${result.id} (${result.oldCommit.slice(0, 9)} → ${result.newCommit.slice(0, 9)}) ended ${result.phase}${result.reason ? ` (${result.reason})` : ""}${result.error ? `: ${result.error}` : ""}.`,
      `Its services may have been down until this runtime (${this.options.runtime.commit.slice(0, 9)}) started.`,
      failures.length ? `Unconfirmed: ${failures.join("; ")}` : "",
      `Inspect: clankie update status; every attempt is in ~/.clankie/updates/${result.id}/service-attempts.jsonl.`,
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 4000);
    // A crash after this claim leaves delivery unknown. It must never replay an uncertain notification.
    await durableJson(path, "claimed");
    let submitted = false;
    try {
      submitted = (await this.options.alert(text, result.initiator?.conversationId)) === true;
    } catch {
      return;
    }
    await durableJson(path, submitted ? "submitted" : "unavailable");
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
