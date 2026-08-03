import { defineTool } from "eve/tools";
import { z } from "zod";
import { captainSelfState, renderCaptainSelfState } from "../../lib/self-state.ts";

/**
 * The on-demand form of the awareness that every turn already receives. It
 * exists for the case the standing summary cannot serve: re-reading presence
 * *after* acting, when a room may have opened or settled mid-turn.
 *
 * Returns the same rendered card as the standing instruction, not the raw
 * state: handed `{active: true, updatedAt: <three minutes ago>}` for a voice
 * channel he was sitting in, he anchored on the timestamp and answered "not
 * in Discord at the moment" — the words "open right now" are the fix, so the
 * tool must say them too.
 */
export default defineTool({
  description:
    "List your own currently open rooms across every lane: operator conversations, Discord voice and text, gameplay. Rooms marked open right now are rooms you are in at this moment — never another room's contents. For what is happening inside your current activity, use observe_current_activity.",
  inputSchema: z.object({}),
  async execute() {
    return renderCaptainSelfState(await captainSelfState());
  },
});
