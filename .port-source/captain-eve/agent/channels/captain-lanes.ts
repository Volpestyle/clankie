import { defineChannel, GET } from "eve/channels";
import { routeAuth } from "eve/channels/auth";
import {
  CAPTAIN_LANE_LISTING_MAX,
  CAPTAIN_LANE_OBSERVATION_PATH,
  CaptainLaneListingSchema,
  type CaptainLaneListing,
} from "@clankie/protocol";
import type { CaptainLaneSnapshot } from "@clankie/captain-runtime";
import { captainLaneRuntime } from "../../lib/lanes/runtime.ts";
import { captainRouteAuth } from "./operator-conversations.ts";

/**
 * Read-only lane listing (ADR 0083). Every durable lane — each Discord server
 * and channel he answers in, voice, gameplay — is its own Eve session, and the
 * operator console could previously only watch the one it was talking in. This
 * publishes the session→lane map the console needs to attach its render-only
 * trace to any other room.
 *
 * Routes-only channel: it never sends, receives, or resumes a turn. Continuation
 * tokens live one layer down in `CaptainLaneResumeState` and are deliberately
 * unreachable from here, so observing a lane can never become steering it.
 */
export function renderCaptainLaneListing(lanes: readonly CaptainLaneSnapshot[]): CaptainLaneListing {
  const observable = [...lanes]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, CAPTAIN_LANE_LISTING_MAX)
    .map((lane) => ({
      lane: lane.lane,
      targetId: lane.targetId,
      ...(lane.sessionId === undefined ? {} : { sessionId: lane.sessionId }),
      state: lane.state,
      updatedAt: new Date(lane.updatedAt).toISOString(),
    }));
  return CaptainLaneListingSchema.parse({ schemaVersion: 1, lanes: observable });
}

export default defineChannel({
  routes: [
    GET(CAPTAIN_LANE_OBSERVATION_PATH, async (request) => {
      const auth = await routeAuth(request, captainRouteAuth());
      if (auth instanceof Response) return auth;
      const runtime = await captainLaneRuntime();
      return Response.json(renderCaptainLaneListing(runtime.registry.list()));
    }),
  ],
});
