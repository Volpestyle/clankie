/**
 * Scheduled official-release installs for hosted bodies (ADR 0237). A check
 * installs only while the body is idle, through the same updater, approval cap
 * and health rollback as `clankie update`. A hold, a refusal or a failed lookup
 * just waits for the next check.
 */
import type { RuntimeUpdater } from "../../tui/bin/runtime-updater.ts";
import type { RuntimeProvider } from "./runtime-provider.ts";

type Heartbeat = NonNullable<RuntimeProvider["heartbeat"]>;

const IN_FLIGHT = new Set(["scheduled", "installing", "stopping", "activating", "restarting"]);

export interface ScheduledUpdateOptions {
  readonly updater: RuntimeUpdater;
  /** The owner's choice; a managed body passes a constant `true`. */
  readonly enabled: () => Promise<boolean>;
  /** No captain turn, activity share, voice call or hired worker is running. */
  readonly idle: () => Promise<boolean>;
  readonly logger: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
  readonly intervalMs?: number;
  /** First check after boot, so a new release never cuts over during startup. */
  readonly initialDelayMs?: number;
}

export function startScheduledUpdates(options: ScheduledUpdateOptions): {
  check(): Promise<string>;
  close(): void;
} {
  const intervalMs = options.intervalMs ?? 60 * 60_000;
  let running = false;
  const check = async (): Promise<string> => {
    if (running) return "busy";
    running = true;
    try {
      if (!(await options.enabled())) return "disabled";
      const status = options.updater.status();
      if (status.pending !== undefined || IN_FLIGHT.has(status.latest?.phase ?? "")) return "in-flight";
      if (!(await options.idle())) return "body-busy";
      let current = true;
      const result = await options.updater.request("latest", {
        guard: async () => {},
        current: () => current,
        initiator: { kind: "schedule" },
      });
      current = false;
      if (result.upToDate) return "up-to-date";
      if (!result.accepted) return "not-accepted";
      options.logger.info(
        { event: "runtime.update.scheduled_install", pending: result.pending },
        "Installing an official release while the body is idle",
      );
      return "accepted";
    } catch (error) {
      // A fleet hold or an unapproved version is a normal wait, not a fault.
      options.logger.info(
        {
          event: "runtime.update.scheduled_wait",
          error: error instanceof Error ? error.message : String(error),
        },
        "Scheduled release install is waiting",
      );
      return "waiting";
    } finally {
      running = false;
    }
  };
  const run = () => void check();
  const initial = setTimeout(run, options.initialDelayMs ?? 10 * 60_000);
  const timer = setInterval(run, intervalMs);
  initial.unref();
  timer.unref();
  return {
    check,
    close: () => {
      clearTimeout(initial);
      clearInterval(timer);
    },
  };
}

/**
 * Idle means nothing a restart would cut: no captain turn or activity share, no
 * live call holding the voice body (between utterances no turn runs), and no
 * hired agent pane in any fleet.
 */
export function bodyIdleCheck(deps: {
  readonly activity: () => BodyActivity;
  readonly voiceHeld: () => boolean;
  readonly agentPanes: () => Promise<number>;
}): () => Promise<boolean> {
  return async () => {
    const { turns, sharing } = deps.activity();
    if (turns > 0 || sharing || deps.voiceHeld()) return false;
    return (await deps.agentPanes()) === 0;
  };
}

/** Running captain turns and live activity shares, counted at the provider's own hooks. */
export interface BodyActivity {
  readonly turns: number;
  readonly sharing: boolean;
}

/**
 * Always supplies turn hooks, delegating to an installed provider's heartbeat,
 * so a body without managed policy can still tell when it is idle.
 */
export function withBodyActivity<P extends { readonly heartbeat?: Heartbeat }>(
  provider: P,
): { readonly provider: P & { readonly heartbeat: Heartbeat }; readonly activity: () => BodyActivity } {
  const inner = provider.heartbeat;
  let turns = 0;
  let sharing = false;
  const heartbeat: Heartbeat = {
    begin(origin) {
      turns += 1;
      const finish = inner?.begin(origin);
      let done = false;
      return () => {
        if (done) return;
        done = true;
        turns -= 1;
        finish?.();
      };
    },
    interactive: () => inner?.interactive(),
    authenticatedWork: (isWork) => inner?.authenticatedWork(isWork),
    activitySharing: (active) => {
      sharing = active;
      inner?.activitySharing(active);
    },
    start: () => inner?.start(),
    close: () => inner?.close(),
  };
  return { provider: { ...provider, heartbeat }, activity: () => ({ turns, sharing }) };
}
