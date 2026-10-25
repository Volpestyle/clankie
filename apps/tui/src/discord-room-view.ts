import { stripVTControlCharacters } from "node:util";
import type {
  DiscordRoomStatus,
  DiscordVoiceJoinRefusal,
  DiscordVoicePipeline,
  DiscordVoiceStayPipelines,
} from "@clankie/protocol";

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
  const unheard = formatUnheardSpeakers(stay.hearing);
  return `${stay.endedAt === undefined ? "This call" : "Last call"}: ${leg("hearing", stay.hearing)}${unheard === undefined ? "" : ` [not heard: ${unheard}]`} · ${leg("answering", stay.answering)}`;
}

/** A join the provider refused before any stay began, with its codes (VUH-2728). */
export function formatVoiceJoinRefusal(refusal: DiscordVoiceJoinRefusal): string {
  const how = [
    refusal.providerCode,
    refusal.closeCode === undefined ? undefined : `close ${refusal.closeCode}`,
  ].filter((value) => value !== undefined);
  return `Join refused at ${refusal.at}: ${refusal.code}${how.length ? ` (${how.join(", ")})` : ""}`;
}

/** Gateway ids are metadata, not terminal control sequences or display-name authority. */
export function formatUnheardSpeakers(hearing: DiscordVoiceStayPipelines["hearing"]): string | undefined {
  return hearing.state !== "broken" || !hearing.brokenUserIds?.length
    ? undefined
    : hearing.brokenUserIds.map((id) => stripVTControlCharacters(id).replace(/[\r\n\t]/gu, " ")).join(", ");
}

/** Admission is deliberately narrower than a working call. */
export function formatVoiceProviderReadiness(
  value: import("@clankie/protocol").VoiceProviderReadiness,
): string {
  return `${value.checkedProvider} listener: ${value.state}${value.providerCode === undefined ? "" : ` (${value.providerCode})`} · ${value.cached ? "cached" : "checked"} ${value.checkedAt} · expires ${value.expiresAt} · no audio or response generated`;
}
