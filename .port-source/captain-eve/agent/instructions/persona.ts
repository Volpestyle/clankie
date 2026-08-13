import { defineDynamic, defineInstructions } from "eve/instructions";
import { captainPersonaInstructions } from "../../lib/persona-context.ts";

/**
 * Injects the character layer: who Clankie is, and how he talks in the room
 * this lane represents. The lane comes from the authenticated channel address,
 * so a Discord message cannot ask for the operator register.
 */
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) =>
      defineInstructions({ markdown: await captainPersonaInstructions(ctx.channel) }),
    "turn.started": async (_event, ctx) =>
      defineInstructions({ markdown: await captainPersonaInstructions(ctx.channel) }),
  },
});
