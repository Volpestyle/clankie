import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ConversationRunner } from "./captain/conversations.ts";
import { parseHerdrAgentList } from "./captain/herdr-census.ts";
import { FleetChangeClock, watchHerdrFleetChanges } from "./captain/herdr-fleet-changes.ts";
import type { HostedBusyReason } from "./hosted-heartbeat.ts";

export type HostedWorkStarted = (reason: HostedBusyReason) => () => void;

/** Self-wakes do not buy idle credit; owner goals and external triggers do. */
export function trackHostedConversationRunner(
  runner: ConversationRunner,
  started?: HostedWorkStarted,
): ConversationRunner {
  if (started === undefined) return runner;
  return async (id, message, publish, context) => {
    const finish =
      context.origin === "wake"
        ? undefined
        : started(context.origin === "goal" ? "scheduled-job" : "captain-turn");
    try {
      await runner(id, message, publish, context);
    } finally {
      finish?.();
    }
  };
}

/**
 * A hosted body's hire limit (VUH-1388): how many Herdr agents run now against
 * the plan's limit. Measured on the real image, an idle hired pi worker costs
 * about 95 MiB, so memory holds dozens; what a plan can actually run at once is
 * bound by the builds and tests those workers start, so the default is two per
 * vCPU (Starter 4, Pro 8). A sample Herdr cannot answer means no limit, rather
 * than a hire refused for a reason nobody can see.
 */
export function hostedHireCapacity(options: {
  readonly limit: number;
  readonly available: () => boolean;
  readonly read?: () => Promise<string>;
}): () => Promise<{ readonly live: number; readonly limit: number } | undefined> {
  const read =
    options.read ??
    (async () =>
      (await promisify(execFile)("herdr", ["agent", "list"], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }))
        .stdout);
  return async () => {
    if (!options.available()) return undefined;
    try {
      return { live: parseHerdrAgentList(await read()).length, limit: options.limit };
    } catch {
      return undefined;
    }
  };
}

/**
 * Watch native agent state even when no app is polling the fleet view.
 *
 * Herdr's change stream fires when panes come and go, not when an agent
 * starts or stops working, so a status change is only seen at the next
 * sample. While any agent exists that sample is every few seconds: at 30 s,
 * a hosted body reported idle while a newly hired worker was already working
 * and busy for most of a minute after it stopped (VUH-1067). With no agents
 * it stays slow; a new pane is a change and samples at once.
 */
export function watchHostedHerdrWork(
  changed: (busy: boolean) => void,
  options: {
    available: () => boolean;
    socketPath?: string;
    read?: () => Promise<string>;
    /** Between samples while any agent exists; default 5 s. */
    activeSampleMs?: number;
    /** Between samples with no agents; default 30 s. */
    idleSampleMs?: number;
  },
): () => void {
  const clock = new FleetChangeClock();
  const stop = watchHerdrFleetChanges(
    clock,
    options.socketPath === undefined ? {} : { socketPath: options.socketPath },
  );
  const read =
    options.read ??
    (async () =>
      (await promisify(execFile)("herdr", ["agent", "list"], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }))
        .stdout);
  const activeSampleMs = options.activeSampleMs ?? 5_000;
  const idleSampleMs = options.idleSampleMs ?? 30_000;
  let closed = false;
  void (async () => {
    while (!closed) {
      const cursor = clock.current();
      let agents = 0;
      try {
        const listed = options.available() ? parseHerdrAgentList(await read()) : [];
        agents = listed.length;
        if (!closed) changed(listed.some((agent) => agent.status === "working"));
      } catch {
        /* An unavailable sample does not claim running work has finished. */
      }
      if (!closed) await clock.wait(cursor, agents > 0 ? activeSampleMs : idleSampleMs);
    }
  })();
  return () => {
    closed = true;
    stop();
    clock.close();
  };
}
