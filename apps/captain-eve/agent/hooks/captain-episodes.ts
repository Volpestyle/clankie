import { defineHook } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import { recordCaptainEpisode } from "../../lib/episodes.ts";
import rememberEpisode from "../tools/remember_episode.ts";

/**
 * Never throws. This hook copied its shape from `captain-presence`, including a
 * timestamp check that threw — and a throw here would escape the hook and end
 * the turn, losing the user's answer to save a note about it. Keeping a memory
 * is worth strictly less than replying, so an event with no durable timing is
 * stamped with the wall clock instead.
 */
function occurredAt(event: { readonly meta?: { readonly at: string } }): string {
  return event.meta?.at ?? new Date().toISOString();
}

/**
 * Turns a composed note into a durable episode, stamped with the room it
 * happened in. The hook is where this belongs rather than the tool: only here
 * are the authenticated channel and the session identity both in reach.
 */
export default defineHook({
  events: {
    "action.result": async (event, ctx) => {
      // Nothing this hook does may end a turn. `recordCaptainEpisode` already
      // swallows transport failures, but reading the tool result or the channel
      // can throw too, and an instruction- or hook-level throw takes the whole
      // session down after eve's retries.
      try {
        const note = toolResultFrom(event.data.result, rememberEpisode);
        if (note === undefined) return;
        await recordCaptainEpisode({
          channel: ctx.channel,
          sessionId: ctx.session.id,
          note: note.output,
          occurredAt: occurredAt(event),
        });
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({
            service: "captain-eve",
            event: "captain_episode.hook_failed",
            errorName: error instanceof Error ? error.name.slice(0, 64) : "Error",
          })}\n`,
        );
      }
    },
  },
});
