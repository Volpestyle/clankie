import { defineDynamic, defineInstructions } from "eve/instructions";
import { captainCeremonyInstructions } from "../../lib/ceremony-instructions.ts";

/**
 * Injects the effective tracker ceremony projection from trusted channel metadata
 * (supplied by the control plane clientContext) on each session/turn boundary.
 */
export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      defineInstructions({ markdown: captainCeremonyInstructions(ctx.channel) }),
    "turn.started": (_event, ctx) =>
      defineInstructions({ markdown: captainCeremonyInstructions(ctx.channel) }),
  },
});
