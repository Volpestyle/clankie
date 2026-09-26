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
