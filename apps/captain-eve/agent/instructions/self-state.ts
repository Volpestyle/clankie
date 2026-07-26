import { defineDynamic, defineInstructions } from "eve/instructions";
import { captainSelfStateInstructions } from "../../lib/self-state.ts";

/**
 * Injects where he currently is. Without this he is one agent with amnesia
 * between rooms: the lane instructions correctly forbid reusing another lane's
 * token or transcript, and with nothing else said about other lanes he
 * generalizes that into "I cannot know anything outside this room" — and
 * answers a plain question about his own presence with a refusal.
 */
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) =>
      defineInstructions({ markdown: await captainSelfStateInstructions(ctx.channel) }),
    "turn.started": async (_event, ctx) =>
      defineInstructions({ markdown: await captainSelfStateInstructions(ctx.channel) }),
  },
});
