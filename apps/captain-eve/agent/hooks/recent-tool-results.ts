import { defineHook, type StreamEventHooks } from "eve/hooks";
import {
  recentToolResultState,
  recordActionRequests,
  recordActionResult,
} from "../../lib/session/recent-tool-results.ts";

export const events: StreamEventHooks = {
  "actions.requested": (event) => {
    recentToolResultState.update((state) => recordActionRequests(state, event.data.actions));
  },
  "action.result": (event) => {
    recentToolResultState.update((state) => recordActionResult(state, event.data.result, event.data.status));
  },
};

export default defineHook({ events });
