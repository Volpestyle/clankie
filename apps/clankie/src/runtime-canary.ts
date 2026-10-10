import { existsSync, mkdirSync } from "node:fs";
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
import { RuntimeHealthSampleSchema, type RuntimeHealthSample } from "./runtime-health-sample.ts";

export const RuntimeCanaryPolicySchema = z
  .strictObject({
    windowMs: z.number().int().min(1000).max(86_400_000).default(300_000),
    sampleIntervalMs: z.number().int().min(50).max(60_000).default(10_000),
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

const HOLDER = "Clankie runtime canary";
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
}

/** Survives a service restart through private operation records and the existing deploy holds. */
export class RuntimeCanary {
  private readonly options: {
    updatesDirectory: string;
    runtime: RuntimeBootIdentity;
    holds: DeployHolds;
    sample: (runtime: RuntimeBootIdentity) => Promise<RuntimeHealthSample>;
    alert?: (text: string) => Promise<boolean>;
    onError?: (error: unknown) => void;
  };
  private session: Session | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private closed = false;

  constructor(options: RuntimeCanary["options"]) {
    this.options = options;
  }

  policy(): RuntimeCanaryPolicy {
    const path = join(this.options.updatesDirectory, "canary-policy.json");
    return RuntimeCanaryPolicySchema.parse(existsSync(path) ? readPrivateJson(path) : {});
  }

  async configure(input: unknown): Promise<RuntimeCanaryPolicy> {
    mkdirSync(this.options.updatesDirectory, { recursive: true, mode: 0o700 });
    privateDirectory(this.options.updatesDirectory);
    return withDirectoryLock(join(this.options.updatesDirectory, "canary-policy.lock"), async () => {
      const policy = RuntimeCanaryPolicySchema.parse({ ...this.policy(), ...object(input) });
      await durableJson(join(this.options.updatesDirectory, "canary-policy.json"), policy);
      return policy;
    });
  }

  status(): RuntimeCanaryResult | undefined {
    return this.latest()?.canary;
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
    if (result.phase === "rolled-back") {
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
    if (result.canary?.state === "failed") {
      if (result.canary.holdEstablished !== true) {
        await this.ensureHold(result, this.previousHealthy(result));
        await this.save(result, { ...result.canary, holdId: result.id, holdEstablished: true });
      }
      return;
    }
    const armed = await this.arm(result);
    if (result.newCommit !== this.options.runtime.commit) {
      await this.fail(
        result,
        { ...result.canary, state: "pending", ...armed },
        "runtime-canary-runtime-changed",
      );
      return;
    }
    this.session = {
      id: result.id,
      policy: armed.policy,
      startedAt: performance.now(),
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
    if (result?.phase === "rolled-back") {
      await this.releasePrehealthyRollback(result);
      return;
    }
    if (!result || result.phase !== "healthy") return;
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
    try {
      sample = RuntimeHealthSampleSchema.parse(await this.options.sample(this.options.runtime));
      if (
        sample.runtime.root !== this.options.runtime.root ||
        sample.runtime.commit !== this.options.runtime.commit ||
        sample.runtime.instanceId !== this.options.runtime.instanceId ||
        sample.runtime.pid !== this.options.runtime.pid
      )
        throw Error("runtime-canary-runtime-changed");
      if (
        Math.abs(Date.now() - Date.parse(sample.observedAt)) >
        Math.max(5000, session.policy.sampleIntervalMs * 2)
      )
        throw Error("runtime-canary-sample-stale");
    } catch {
      if (!this.closed) await this.fail(result, result.canary, "runtime-canary-health-unavailable");
      return;
    }
    if (this.closed) return;
    const now = performance.now();
    if (
      session.lastSampleAt !== undefined &&
      now - session.lastSampleAt > session.policy.sampleIntervalMs * 3
    ) {
      await this.fail(result, result.canary, "runtime-canary-sampling-gap");
      return;
    }
    session.lastSampleAt = now;
    session.latencies.push(sample.healthLatencyMs);
    session.cpuTotal += sample.cpuPercent * sample.intervalMs;
    session.cpuDurationMs += sample.intervalMs;
    const sorted = [...session.latencies].sort((a, b) => a - b);
    const healthP95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    const cpuMeanPercent = session.cpuTotal / session.cpuDurationMs;
    const canary: RuntimeCanaryResult = {
      ...result.canary,
      samples: session.latencies.length,
      cpuMeanPercent,
      healthP95Ms,
    };
    if (now - session.startedAt < session.policy.windowMs) {
      await this.save(result, canary);
      return;
    }
    if (session.latencies.length < 2) {
      await this.fail(result, canary, "runtime-canary-samples-incomplete");
    } else if (cpuMeanPercent > session.policy.cpuPercent) {
      await this.fail(result, canary, "runtime-canary-cpu-budget-exceeded");
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
    let delivered = false;
    try {
      delivered =
        (await this.options.alert?.(
          `Runtime canary held further deploys for ${result.newCommit}: ${claimed.error ?? "health unavailable"}. Previous healthy commit: ${claimed.previousHealthyCommit ?? result.oldCommit}. CPU mean ${claimed.cpuMeanPercent?.toFixed(2) ?? "unavailable"}% (one core); health p95 ${claimed.healthP95Ms?.toFixed(2) ?? "unavailable"}ms. No automatic rollback; inspect update status and the retained previous runtime.`,
        )) === true;
    } catch {
      // Alert transport failure does not remove a durable deployment hold.
    }
    await this.save(result, { ...claimed, alertState: delivered ? "delivered" : "unavailable" });
  }

  private async releasePassed(result: RuntimeUpdateResult): Promise<void> {
    if (!result.canary || result.canary.state !== "passed") return;
    if (result.canary.holdReleased === true) return;
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
        "Runtime canary passed its full CPU and latency window",
        wanted,
      );
    }
    await durableJson(join(this.options.updatesDirectory, "healthy-canary.json"), {
      commit: result.newCommit,
    });
    await this.save(result, { ...result.canary, holdReleased: true });
  }

  private async releasePrehealthyRollback(result: RuntimeUpdateResult): Promise<void> {
    if (
      result.rollbackHealthy !== true ||
      result.oldCommit !== this.options.runtime.commit ||
      result.canary?.state === "failed" ||
      result.canary?.state === "passed"
    )
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
    // The existing helper restored and verified its old runtime before a canary ever began.
    await this.options.holds.release(
      wanted.id,
      HOLDER,
      "Pre-canary cutover restored its confirmed previous runtime",
      wanted,
    );
  }
}
