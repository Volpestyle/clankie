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

/** Watch native agent state even when no app is polling the fleet view. */
export function watchHostedHerdrWork(
  changed: (busy: boolean) => void,
  options: {
    available: () => boolean;
    socketPath?: string;
    read?: () => Promise<string>;
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
  let closed = false;
  void (async () => {
    while (!closed) {
      const cursor = clock.current();
      try {
        const busy =
          options.available() &&
          parseHerdrAgentList(await read()).some((agent) => agent.status === "working");
        if (!closed) changed(busy);
      } catch {
        /* An unavailable sample does not claim running work has finished. */
      }
      if (!closed) await clock.wait(cursor, 30_000);
    }
  })();
  return () => {
    closed = true;
    stop();
    clock.close();
  };
}
