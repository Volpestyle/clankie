import type { LeadChat } from "@clankie/protocol";
export type { LeadChat } from "@clankie/protocol";

export function renderLeadChats(chats: readonly LeadChat[]): string {
  return [
    "# Your lead chats",
    "These are private operator leads. Reach a connected sibling with message_seat, using its messageSeat conversation ID. A stored timestamp is activity history, not proof of a live receiver.",
    JSON.stringify(chats, null, 2),
  ].join("\n");
}
