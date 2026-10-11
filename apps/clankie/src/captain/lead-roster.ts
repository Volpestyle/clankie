import type { OperatorConversationSessionState, OperatorSeatBridgeStatus } from "@clankie/protocol";

/** Private operator context; no transcript, task content or credentials. */
export interface LeadChat {
  conversationId: string;
  title: string;
  projects: readonly { id: string; name: string }[];
  workspace: string;
  machine: string;
  holder: { kind: "native"; seatId: string; harness: string } | { kind: "service"; lane: "operator" };
  state: OperatorSeatBridgeStatus["state"] | "service";
  activity: OperatorConversationSessionState;
  lastActiveAt: string;
  lastBridgeSeenAt?: string;
  messageSeat: string;
  messageAvailable: boolean;
}

export function renderLeadChats(chats: readonly LeadChat[]): string {
  return [
    "# Your lead chats",
    "These are private operator leads. Reach a connected sibling with message_seat, using its messageSeat conversation ID. A stored timestamp is activity history, not proof of a live receiver.",
    JSON.stringify(chats, null, 2),
  ].join("\n");
}
