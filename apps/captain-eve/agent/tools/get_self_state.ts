import { defineTool } from "eve/tools";
import { z } from "zod";
import { captainSelfState } from "../../lib/self-state.ts";

/**
 * The on-demand form of the awareness that every turn already receives. It
 * exists for the case the standing summary cannot serve: re-reading presence
 * *after* acting, when a room may have opened or settled mid-turn.
 */
export default defineTool({
  description:
    "List your own currently open rooms across every lane: operator conversations, Discord voice and text, gameplay. Returns where you are and when you were last active there — never another room's contents.",
  inputSchema: z.object({}),
  async execute() {
    return captainSelfState();
  },
});
