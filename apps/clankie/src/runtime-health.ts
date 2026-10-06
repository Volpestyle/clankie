import { performance } from "node:perf_hooks";
import {
  RuntimeHealthObservationSchema,
  RuntimeHealthSettingsSchema,
  type RuntimeHealthObservation,
  type RuntimeHealthSettings,
} from "@clankie/protocol";

/** Observes this service process, independently of whole-machine resource telemetry. */
export class RuntimeHealthObserver {
  private observation: RuntimeHealthObservation = {
    state: "starting",
    durationMs: 0,
    reasons: [],
    delivery: "none",
  };
  private configuration = RuntimeHealthSettingsSchema.parse({});
  private previousCpu = process.cpuUsage();
  private previousTime = performance.now();
  private unhealthySince: number | undefined;
  private alarmed = false;
  private alertAccepted = false;
  private nextAlertAttempt = 0;
  private lastAlarm = -Infinity;
  private recovery: { text: string; nextAttempt: number } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private running = false;
  private readonly shutdown = new AbortController();
  private readonly options: {
    settings(): Promise<RuntimeHealthSettings>;
    healthUrl: string;
    notify(text: string): Promise<boolean>;
    observed?(observation: RuntimeHealthObservation): void;
    unavailable?(): void;
  };

  constructor(options: RuntimeHealthObserver["options"]) {
    this.options = options;
  }

  snapshot(): RuntimeHealthObservation {
    return structuredClone(this.observation);
  }

  start(): void {
    if (this.running || this.stopped) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    this.shutdown.abort();
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.sample()
        .catch(() => this.options.unavailable?.())
        .finally(() => {
          this.schedule(this.configuration.sampleIntervalMs);
        });
    }, delay);
    this.timer.unref();
  }

  private async sample(): Promise<void> {
    this.configuration = RuntimeHealthSettingsSchema.parse(await this.options.settings());
    const settings = this.configuration;
    const cpu = process.cpuUsage();
    const time = performance.now();
    const elapsed = time - this.previousTime;
    const cpuPercent = Math.min(
      10_000,
      Math.max(
        0,
        Math.round(
          ((cpu.user - this.previousCpu.user + cpu.system - this.previousCpu.system) /
            Math.max(1, elapsed * 1000)) *
            1000,
        ) / 10,
      ),
    );
    this.previousCpu = cpu;
    this.previousTime = time;
    if (!settings.enabled) {
      delete this.observation.healthLatencyMs;
      delete this.observation.healthAvailable;
      this.unhealthySince = undefined;
      this.alarmed = false;
      this.alertAccepted = false;
      this.recovery = undefined;
      this.observation = {
        ...this.observation,
        state: "disabled",
        observedAt: new Date().toISOString(),
        cpuPercent,
        durationMs: 0,
        reasons: [],
        delivery: "none",
      };
      this.publish();
      return;
    }
    const healthStart = performance.now();
    let healthAvailable = false;
    try {
      const response = await fetch(this.options.healthUrl, {
        signal: AbortSignal.any([
          this.shutdown.signal,
          AbortSignal.timeout(Math.max(1000, settings.healthLatencyMs * 2)),
        ]),
        redirect: "error",
      });
      // Read the complete response: stalled response bodies are slow health too.
      await response.arrayBuffer();
      healthAvailable = response.ok;
    } catch {
      /* A timeout or failed health response is a health failure. */
    }
    if (this.stopped) return;
    const healthLatencyMs = Math.min(86_400_000, Math.round(performance.now() - healthStart));
    const now = Date.now();
    const observedAt = new Date(now).toISOString();
    const reasons: RuntimeHealthObservation["reasons"] = [];
    if (cpuPercent > settings.cpuPercent) reasons.push("cpu");
    if (!healthAvailable || healthLatencyMs > settings.healthLatencyMs) reasons.push("health");
    if (reasons.length && this.unhealthySince === undefined) this.unhealthySince = now;
    const durationMs = this.unhealthySince === undefined ? 0 : Math.max(0, now - this.unhealthySince);
    let state: RuntimeHealthObservation["state"] = reasons.length ? "sustaining" : "healthy";
    if (reasons.length && durationMs >= settings.sustainedMs) {
      if (!this.alarmed && now - this.lastAlarm >= settings.cooldownMs) {
        this.alarmed = true;
        this.lastAlarm = now;
        this.nextAlertAttempt = 0;
        this.observation.lastAlarmAt = observedAt;
      }
      state = this.alarmed ? "alarm" : "cooldown";
      if (this.alarmed && !this.alertAccepted && now >= this.nextAlertAttempt) {
        this.alertAccepted = await this.notify(
          `Runtime health alarm: ${reasons.join(" and ")} held for ${durationMs}ms at ${observedAt}. ` +
            `Clankie process CPU ${cpuPercent}% (threshold ${settings.cpuPercent}%); /health ${healthLatencyMs}ms ` +
            `(${healthAvailable ? "available" : "unavailable"}, threshold ${settings.healthLatencyMs}ms). ` +
            "Inspect clankie status or clankie doctor; include the incident in the next Linear project check-in.",
        );
        this.nextAlertAttempt = now + Math.max(60_000, settings.sampleIntervalMs);
      }
    } else if (!reasons.length && this.unhealthySince !== undefined) {
      if (this.alarmed) {
        this.observation.lastIncidentDurationMs = durationMs;
        this.observation.lastRecoveryAt = observedAt;
      }
      if (this.alertAccepted)
        this.recovery = {
          text:
            `Runtime health recovered after ${durationMs}ms at ${observedAt}: Clankie process CPU ${cpuPercent}%; /health ${healthLatencyMs}ms. ` +
            "Include this recovery and incident duration in the next Linear project check-in.",
          nextAttempt: 0,
        };
      this.unhealthySince = undefined;
      this.alarmed = false;
      this.alertAccepted = false;
    }
    let delivery = this.observation.delivery;
    if (state === "alarm") delivery = this.alertAccepted ? "accepted" : "unavailable";
    if (this.recovery && now >= this.recovery.nextAttempt) {
      if (await this.notify(this.recovery.text)) {
        this.recovery = undefined;
        delivery = "accepted";
      } else {
        this.recovery.nextAttempt = now + Math.max(60_000, settings.sampleIntervalMs);
        delivery = "unavailable";
      }
    }
    this.observation = {
      ...this.observation,
      state,
      observedAt,
      cpuPercent,
      healthLatencyMs,
      healthAvailable,
      durationMs: reasons.length ? durationMs : 0,
      reasons,
      delivery,
    };
    this.publish();
  }

  private async notify(text: string): Promise<boolean> {
    try {
      return await this.options.notify(text);
    } catch {
      return false;
    }
  }
  private publish(): void {
    this.options.observed?.(RuntimeHealthObservationSchema.parse(this.snapshot()));
  }
}
