import type { DiscordRoomEvidence, DiscordVoiceEvidence } from "@clankie/protocol";

/** Only observed input, explicit silence/failure, and confirmed audible drain become room health. */
export function voiceRoomEvidence(
  evidence: DiscordVoiceEvidence,
  source: { presenceSessionId: string; transportKind: "bot" | "user_session" },
): DiscordRoomEvidence[] {
  if (
    evidence.stayId === undefined ||
    !("deliveryId" in evidence) ||
    evidence.deliveryId === undefined ||
    !("userId" in evidence) ||
    evidence.userId === undefined
  )
    return [];
  const outcomes: { outcome: DiscordRoomEvidence["outcome"]; reason?: string }[] = [];
  if (
    (evidence.type === "transcription" && evidence.outcome === "accepted") ||
    evidence.type === "text_input"
  )
    outcomes.push({ outcome: "accepted" });
  if (evidence.type === "floor_decision" && (evidence.action === "ignore" || evidence.action === "listen"))
    outcomes.push({ outcome: "declined", reason: evidence.reason ?? `voice_floor_${evidence.action}` });
  if (evidence.type === "failed") outcomes.push({ outcome: "failed", reason: evidence.code });
  // This callback is emitted only after actual started+drained playback, in the
  // same live generation with the original pending response still tracked.
  if (evidence.type === "response" && evidence.playbackId !== undefined && evidence.trigger === "room") {
    outcomes.push({ outcome: "settled" });
    if (evidence.state === "waiting_user")
      outcomes.push({ outcome: "escalated", reason: "voice_waiting_user" });
  }
  return outcomes.map(({ outcome, reason }) => ({
    ...source,
    id: `${evidence.deliveryId}:${outcome}`,
    voiceStayId: evidence.stayId!,
    guildId: evidence.guildId,
    channelId: evidence.channelId,
    actorId: evidence.userId!,
    deliveryId: evidence.deliveryId!,
    outcome,
    ...(reason === undefined ? {} : { reason }),
  }));
}
