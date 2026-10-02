import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { probeHostPower, type HostPowerReport, type PowerExec } from "@clankie/protocol/host-power";

const execFileAsync = promisify(execFileCallback);
const PMSET_TIMEOUT_MS = 5_000;
/** A timer that fires this much later than scheduled means the host was asleep. */
const SLEEP_GAP_MS = 45_000;
const TICK_MS = 15_000;
const REFRESH_MS = 60_000;

export interface HostPowerMonitor {
  /** The latest reading; `unknown` until the first probe lands. Never throws, never blocks. */
  report(): HostPowerReport;
  stop(): void;
}

export interface HostPowerMonitorOptions {
  /** Read fresh each probe so `clankie awake on` is seen without a restart. */
  readonly keepAwakeRequested: () => Promise<boolean>;
  readonly onSleep?: (sleep: NonNullable<HostPowerReport["lastSleep"]>) => void;
  readonly exec?: PowerExec;
  readonly now?: () => number;
  readonly tickMs?: number;
  readonly refreshMs?: number;
  readonly sleepGapMs?: number;
}

/**
 * Tells the app and doctor what this host's power state means (VUH-1461).
 *
 * The service cannot observe itself asleep, so sleep is inferred the only way a
 * process can: a timer that fires far later than it was set. That also catches
 * DarkWake, where the process runs for seconds and the host goes straight back
 * down. The pmset probe is cached and refreshed on a slow timer because
 * `/health` is read often and must stay synchronous.
 */
export function createHostPowerMonitor(options: HostPowerMonitorOptions): HostPowerMonitor {
  const now = options.now ?? Date.now;
  const exec = options.exec ?? defaultExec;
  const tickMs = options.tickMs ?? TICK_MS;
  const sleepGapMs = options.sleepGapMs ?? SLEEP_GAP_MS;
  let lastTick = now();
  let lastSleep: HostPowerReport["lastSleep"];
  let latest: HostPowerReport | undefined;
  let probing = false;

  const refresh = async (): Promise<void> => {
    if (probing) return;
    probing = true;
    try {
      latest = await probeHostPower({
        exec,
        keepAwakeRequested: await options.keepAwakeRequested().catch(() => false),
        ...(lastSleep === undefined ? {} : { lastSleep }),
      });
    } finally {
      probing = false;
    }
  };

  const tick = setInterval(() => {
    const current = now();
    if (current - lastTick > tickMs + sleepGapMs) {
      lastSleep = {
        sleptAt: new Date(lastTick).toISOString(),
        wokeAt: new Date(current).toISOString(),
        seconds: Math.round((current - lastTick) / 1_000),
      };
      options.onSleep?.(lastSleep);
      // Waking often changes the source too (lid opened on battery).
      void refresh();
    }
    lastTick = current;
  }, tickMs);
  const slow = setInterval(() => void refresh(), options.refreshMs ?? REFRESH_MS);
  tick.unref();
  slow.unref();
  void refresh();

  return {
    report: () =>
      latest === undefined
        ? {
            state: "unknown",
            source: "unknown",
            sleepAfterMinutes: null,
            heldAwakeBy: [],
            keepAwakeRequested: false,
            ...(lastSleep === undefined ? {} : { lastSleep }),
          }
        : { ...latest, ...(lastSleep === undefined ? {} : { lastSleep }) },
    stop: () => {
      clearInterval(tick);
      clearInterval(slow);
    },
  };
}

const defaultExec: PowerExec = async (command, args) => {
  const result = await execFileAsync(command, [...args], { encoding: "utf8", timeout: PMSET_TIMEOUT_MS });
  return { stdout: result.stdout, stderr: result.stderr };
};
