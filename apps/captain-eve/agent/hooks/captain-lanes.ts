import { defineHook } from "eve/hooks";
import { reconcileEveLaneSession } from "../../lib/lanes/runtime.ts";

/**
 * Reconciles the durable lane session state on lifecycle events. The continuation
 * token comes from `ctx.session` (the authored channel context/metadata may not
 * expose it) and is a private input only — never the public conversation contract.
 */
function reconcile(state: "active" | "waiting" | "completed" | "failed") {
  return (
    _event: unknown,
    ctx: {
      channel: { kind?: string; continuationToken?: string };
      session: { id: string; continuationToken?: string };
    },
  ) =>
    reconcileEveLaneSession({
      channel: ctx.channel,
      sessionId: ctx.session.id,
      ...(ctx.session.continuationToken === undefined
        ? {}
        : { continuationToken: ctx.session.continuationToken }),
      state,
    });
}

export default defineHook({
  events: {
    "session.started": reconcile("active"),
    "turn.started": reconcile("active"),
    "session.waiting": reconcile("waiting"),
    "session.completed": reconcile("completed"),
    "session.failed": reconcile("failed"),
  },
});
