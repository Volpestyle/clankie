import type { ReplayOperatorConversationRequest, SubmitOperatorConversationTurn } from "@clankie/protocol";
import type { ConversationStore } from "../src/captain/conversations.ts";

export function sendMessage(
  store: ConversationStore,
  turn: Omit<SubmitOperatorConversationTurn, "schemaVersion" | "kind">,
) {
  return store.serve({
    op: "send",
    schemaVersion: 1,
    turn: { schemaVersion: 1, kind: "message", ...turn },
  });
}

export function replayConversation(
  store: ConversationStore,
  replay: Omit<ReplayOperatorConversationRequest, "schemaVersion">,
) {
  return store.serve({ op: "replay", schemaVersion: 1, replay: { schemaVersion: 1, ...replay } });
}

export function tailConversation(
  store: ConversationStore,
  tail: Omit<ReplayOperatorConversationRequest, "schemaVersion">,
) {
  return store.serve({ op: "tail", schemaVersion: 1, tail: { schemaVersion: 1, ...tail } });
}
