import { defineDynamic, defineInstructions } from "eve/instructions";
import { captainEpisodeInstructions } from "../../lib/episodes.ts";

/**
 * Injects what he remembers doing in his other rooms, scoped to this one.
 *
 * Recall is an instruction rather than a tool on purpose. The lane decides
 * which episodes are legible, so if the model could call for recall it could be
 * talked into asking for the operator lane's — and answering from a public
 * Discord channel with something out of a private conversation. Here the lane
 * comes from the channel the control plane stamped, and the model has no say.
 */
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) =>
      defineInstructions({ markdown: await captainEpisodeInstructions(ctx.channel) }),
    "turn.started": async (_event, ctx) =>
      defineInstructions({ markdown: await captainEpisodeInstructions(ctx.channel) }),
  },
});
