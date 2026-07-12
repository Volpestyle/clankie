import { defineDynamic, defineInstructions } from "eve/instructions";
import { captainLaneInstructions } from "../../lib/lanes/context.ts";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) =>
      defineInstructions({ markdown: captainLaneInstructions(ctx.channel) }),
    "turn.started": (_event, ctx) => defineInstructions({ markdown: captainLaneInstructions(ctx.channel) }),
  },
});
