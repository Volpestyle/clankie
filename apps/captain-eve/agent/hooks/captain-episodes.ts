import { defineHook } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import { recordCaptainEpisode } from "../../lib/episodes.ts";
import rememberEpisode from "../tools/remember_episode.ts";

function occurredAt(event: { readonly meta?: { readonly at: string } }): string {
  if (event.meta?.at === undefined) throw new Error("Captain episodes require durable event timing metadata");
  return event.meta.at;
}

/**
 * Turns a composed note into a durable episode, stamped with the room it
 * happened in. The hook is where this belongs rather than the tool: only here
 * are the authenticated channel and the session identity both in reach.
 */
export default defineHook({
  events: {
    "action.result": async (event, ctx) => {
      const note = toolResultFrom(event.data.result, rememberEpisode);
      if (note === undefined) return;
      await recordCaptainEpisode({
        channel: ctx.channel,
        sessionId: ctx.session.id,
        note: note.output,
        occurredAt: occurredAt(event),
      });
    },
  },
});
