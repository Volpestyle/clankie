import { defineDynamic, defineInstructions } from "eve/instructions";
import {
  captainCeremonyInstructions,
  verifyCeremonyProjectionEnvelope,
} from "../../lib/ceremony-instructions.ts";

/**
 * Injects tracker ceremony instructions only from an HMAC-authenticated
 * control-plane envelope. Caller-controlled channel/client context is advisory
 * until it verifies under CLANKIE_CAPTAIN_TOKEN.
 */
export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const trusted = verifyCeremonyProjectionEnvelope(
        ctx.channel.metadata,
        process.env.CLANKIE_CAPTAIN_TOKEN,
      );
      return defineInstructions({
        markdown: captainCeremonyInstructions(trusted),
      });
    },
    "turn.started": (_event, ctx) => {
      const trusted = verifyCeremonyProjectionEnvelope(
        ctx.channel.metadata,
        process.env.CLANKIE_CAPTAIN_TOKEN,
      );
      return defineInstructions({
        markdown: captainCeremonyInstructions(trusted),
      });
    },
  },
});
