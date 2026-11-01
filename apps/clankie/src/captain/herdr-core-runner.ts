import type { HerdrAgentSession } from "./herdr-transcript.ts";
import type { HerdrAgentSnapshot, HerdrWatchRunner } from "./herdr-watch.ts";
import { SEAT_LABEL, type HerdrCoreSeats, type HerdrCoreTerminal } from "./herdr-core-seats.ts";

// Clankie's hires in the Herdr desktop app's terminals (ADR 0319), seen the way his
// seat code sees a Herdr pane. Routed under one reserved prefix (`herdr-core/t7`), so
// a seat, a receipt or a watch keeps naming the core's terminal across restarts. Only
// terminals Clankie started (labeled with a seat) answer: an owner's own terminal is
// read through the connector's session source, never driven here.

/** The prefix a desktop-app terminal's seat id carries; no Herdr fleet may take it. */
export const HERDR_CORE_FLEET = "herdr-core";

/** The agent status OSC 7501 reports, in the words Herdr uses for a pane's agent. */
const STATUSES = new Set(["idle", "working", "blocked", "done"]);
const SETTLED = new Set(["idle", "done", "blocked"]);
const POLL_MS = 500;
const IDLE_WAIT_MS = 30_000;
const HISTORY_LINES = 2_000;

/** The agent name Herdr gives the app a 7501 report names. */
function agentOf(app: string | undefined): string {
  if (app === undefined) return "unknown";
  if (app === "claude-code" || app === "claude") return "claude";
  return app;
}

export interface HerdrCoreRunnerOptions {
  readonly seats: HerdrCoreSeats;
  /** The native session a hire was launched into, which the core itself doesn't know. */
  readonly session?: (address: string) => HerdrAgentSession | undefined;
  readonly pollMs?: number;
}

/** The read and lifecycle half of a seat runner for the desktop app's core; hiring comes later. */
export function createHerdrCoreRunner(
  options: HerdrCoreRunnerOptions,
): HerdrWatchRunner & Required<Pick<HerdrWatchRunner, "readPane" | "closePane">> {
  const { seats } = options;
  const pollMs = options.pollMs ?? POLL_MS;
  const snapshot = (terminal: HerdrCoreTerminal): HerdrAgentSnapshot => {
    const session = options.session?.(terminal.address);
    const seat = terminal.labels[SEAT_LABEL];
    const live = terminal.state === "live";
    return {
      paneId: terminal.address,
      terminalId: terminal.address,
      ...(seat === undefined ? {} : { name: seat }),
      agent: live ? agentOf(terminal.app) : "unknown",
      status: !live
        ? "offline"
        : terminal.status !== undefined && STATUSES.has(terminal.status)
          ? terminal.status
          : "unknown",
      title: terminal.title ?? "",
      ...(session === undefined ? {} : { session }),
      ...(terminal.cwd === undefined ? {} : { workingDirectory: terminal.cwd }),
    };
  };
  /** A terminal of Clankie's own, or undefined: the core no longer has it, or it isn't his. */
  const own = async (address: string): Promise<HerdrCoreTerminal | undefined> => {
    const terminal = await seats.get(address);
    return terminal?.labels[SEAT_LABEL] === undefined ? undefined : terminal;
  };
  const get = async (address: string): Promise<HerdrAgentSnapshot> => {
    const terminal = await own(address);
    if (terminal === undefined) throw new Error(`The desktop app has no Clankie terminal ${address}`);
    return snapshot(terminal);
  };
  /** Polls until `done` holds for the terminal's snapshot, it is gone, or the signal ends the wait. */
  const until = async (
    address: string,
    done: (agent: HerdrAgentSnapshot) => boolean,
    signal: AbortSignal,
    timeoutMs?: number,
  ): Promise<HerdrAgentSnapshot> => {
    const end = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    for (;;) {
      signal.throwIfAborted();
      const agent = await get(address);
      if (done(agent) || agent.status === "offline" || (end !== undefined && Date.now() >= end)) return agent;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, pollMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    }
  };
  return {
    get,
    resolveTerminal: async (address) => {
      const terminal = await own(address);
      return terminal === undefined ? undefined : snapshot(terminal);
    },
    wait: (address, signal) => until(address, (agent) => SETTLED.has(agent.status), signal),
    waitForChange: (address, current, signal) => until(address, (agent) => agent.status !== current, signal),
    waitUntilIdle: (address, signal) =>
      until(address, (agent) => ["idle", "working", "done"].includes(agent.status), signal, IDLE_WAIT_MS),
    readPane: async (address, source) => {
      if ((await own(address)) === undefined)
        throw new Error(`The desktop app has no Clankie terminal ${address}`);
      return seats.read(address, source === "visible" ? 0 : HISTORY_LINES);
    },
    closePane: async (address, guard) => {
      await guard?.();
      if ((await own(address)) === undefined) return;
      await seats.kill(address);
    },
  };
}
