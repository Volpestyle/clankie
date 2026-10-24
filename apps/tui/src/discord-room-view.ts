import type { DiscordRoomStatus, DiscordVoicePipeline, DiscordVoiceStayPipelines } from "@clankie/protocol";

/** Plain text works in the live TUI result pane and headless operator output. */
export function formatDiscordRoomStatus(room: DiscordRoomStatus): string {
  return [
    `${room.title ?? room.targetId ?? room.conversationId} · ${room.conversationId}`,
    room.coverage === "unknown"
      ? "Delivery health unknown — no current observations"
      : `Received ${room.received} · answered ${room.answered} · silent ${room.silent} · missed ${room.missed} · failed ${room.failed}`,
    `Unrecovered failures ${room.unrecoveredFailed ?? "unknown"}${room.abandoned ? ` · abandoned after permanent refusal ${room.abandoned}` : ""}`,
    `Pending ${room.pending} · absorbed with unconfirmed answer ${room.absorbedUnknown}`,
    ...(room.lastReason === undefined ? [] : [`Reason: ${room.lastReason}`]),
    `Private guidance: ${room.guidance.state}`,
    ...(room.guidance.text === undefined ? [] : [room.guidance.text]),
    "Heard, said and tools: inspect this room in /conversation. Guidance waits for its next admitted turn.",
  ].join("\n");
}

/** The latest voice stay's hearing and answering, with how a lost provider session ended (VUH-2728). */
export function formatVoiceStayPipelines(stay: DiscordVoiceStayPipelines): string {
  const leg = (name: string, pipeline: DiscordVoicePipeline) => {
    const loss = pipeline.lastLoss;
    const how = [
      loss?.closeReason,
      loss?.closeCode === undefined ? undefined : `close ${loss.closeCode}`,
      loss?.providerCode,
    ].filter((value) => value !== undefined);
    return `${name} ${pipeline.state}${loss === undefined ? "" : ` (${pipeline.losses} lost, last ${loss.code}${how.length ? `: ${how.join(", ")}` : ""})`}`;
  };
  return `${stay.ended ? "Last call" : "This call"}: ${leg("hearing", stay.hearing)} · ${leg("answering", stay.answering)}`;
}
