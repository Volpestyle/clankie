import { defineHook } from "eve/hooks";
import { reconcileEveLaneSession } from "../../lib/lanes/runtime.ts";

export default defineHook({
  events: {
    "session.started": (_event, ctx) =>
      reconcileEveLaneSession({ channel: ctx.channel, sessionId: ctx.session.id, state: "active" }),
    "turn.started": (_event, ctx) =>
      reconcileEveLaneSession({ channel: ctx.channel, sessionId: ctx.session.id, state: "active" }),
    "session.waiting": (_event, ctx) =>
      reconcileEveLaneSession({ channel: ctx.channel, sessionId: ctx.session.id, state: "waiting" }),
    "session.completed": (_event, ctx) =>
      reconcileEveLaneSession({ channel: ctx.channel, sessionId: ctx.session.id, state: "completed" }),
    "session.failed": (_event, ctx) =>
      reconcileEveLaneSession({ channel: ctx.channel, sessionId: ctx.session.id, state: "failed" }),
  },
});
