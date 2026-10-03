import type { DiscordRoomStatus } from "@clankie/protocol";

/** Plain text works in the live TUI result pane and headless operator output. */
export function formatDiscordRoomStatus(room: DiscordRoomStatus): string {
  return [
    `${room.title ?? room.targetId ?? room.conversationId} · ${room.conversationId}`,
    room.coverage === "unknown"
      ? "Delivery health unknown — no current observations"
      : `Received ${room.received} · answered ${room.answered} · silent ${room.silent} · missed ${room.missed} · failed ${room.failed}`,
    `Pending ${room.pending} · absorbed with unconfirmed answer ${room.absorbedUnknown}`,
    ...(room.lastReason === undefined ? [] : [`Reason: ${room.lastReason}`]),
    `Private guidance: ${room.guidance.state}`,
    ...(room.guidance.text === undefined ? [] : [room.guidance.text]),
    "Heard, said and tools: inspect this room in /conversation. Guidance waits for its next admitted turn.",
  ].join("\n");
}
