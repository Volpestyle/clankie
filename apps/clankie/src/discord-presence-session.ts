import {
  DiscordPresencePhaseEventSchema,
  DiscordPresenceSessionRecordSchema,
  type DiscordPresencePhaseEvent,
  type DiscordPresenceSessionRecord,
  type DiscordVoiceRoom,
  type DiscordVoiceStay,
} from "@clankie/interactive-environment";
import type { DiscordPresenceChannelIdentity, DomainEvent } from "@clankie/protocol";

export const DISCORD_PRESENCE_EVENT_STREAM_ID = "discord-presence" as const;

export class DiscordPresenceSessionProjection {
  private readonly sessions = new Map<string, DiscordPresenceSessionRecord>();

  public constructor(events: readonly DomainEvent[] = []) {
    for (const event of events) {
      const parsed = phaseEventFromDomainEvent(event);
      if (parsed !== undefined) this.apply(parsed);
    }
  }

  public apply(event: DiscordPresencePhaseEvent): DiscordPresenceSessionRecord {
    const parsed = DiscordPresencePhaseEventSchema.parse(event);
    const session = parsed.data.session;
    const key = bindingKey(session);
    const previous = this.sessions.get(key);
    if (previous === undefined) {
      if (
        parsed.data.reason !== "process_start" ||
        parsed.data.previousPhase !== "off" ||
        session.phase !== "connecting" ||
        session.revision !== 1
      ) {
        throw new Error("discord_presence_session_initial_transition_invalid");
      }
      this.sessions.set(key, structuredClone(session));
      return structuredClone(session);
    }
    if (previous.sessionId !== session.sessionId) {
      if (
        parsed.data.reason !== "process_start" ||
        parsed.data.previousPhase !== "off" ||
        session.phase !== "connecting" ||
        session.revision !== 1
      ) {
        throw new Error("discord_presence_session_binding_conflict");
      }
      this.sessions.set(key, structuredClone(session));
      return structuredClone(session);
    }
    if (session.revision < previous.revision) {
      throw new Error("discord_presence_session_revision_stale");
    }
    if (session.revision === previous.revision) {
      if (JSON.stringify(session) !== JSON.stringify(previous)) {
        throw new Error("discord_presence_session_revision_conflict");
      }
      return structuredClone(previous);
    }
    if (parsed.data.previousPhase !== previous.phase) {
      throw new Error("discord_presence_session_previous_phase_conflict");
    }
    // A bridge that lost an acknowledgement may be ahead of the durable
    // projection. Rebase its authenticated target snapshot onto the next
    // contiguous revision so both sides self-heal without a process restart.
    const projected =
      session.revision === previous.revision + 1
        ? session
        : DiscordPresenceSessionRecordSchema.parse({
            ...session,
            revision: previous.revision + 1,
          });
    this.sessions.set(key, structuredClone(projected));
    return structuredClone(projected);
  }

  public resolve(
    identity: Pick<DiscordPresenceChannelIdentity, "characterId" | "credentialRef" | "transportKind">,
  ): DiscordPresenceSessionRecord | undefined {
    const session = this.sessions.get(bindingKey(identity));
    return session === undefined ? undefined : structuredClone(session);
  }

  public list(): DiscordPresenceSessionRecord[] {
    return [...this.sessions.values()].map((session) => structuredClone(session));
  }
}

export function discordPresenceDomainEvent(
  event: DiscordPresencePhaseEvent,
  profileHash: string,
): DomainEvent {
  const parsed = DiscordPresencePhaseEventSchema.parse(event);
  return {
    id: parsed.id,
    occurredAt: parsed.occurredAt,
    missionId: `${DISCORD_PRESENCE_EVENT_STREAM_ID}:${parsed.sessionId}`,
    streamKind: "discord_presence",
    correlationId: parsed.correlationId,
    profileHash,
    type: parsed.type,
    data: parsed.data,
  };
}

function phaseEventFromDomainEvent(event: DomainEvent): DiscordPresencePhaseEvent | undefined {
  if (event.type !== "discord.presence.session.phase_changed") return undefined;
  if (!event.missionId.startsWith(`${DISCORD_PRESENCE_EVENT_STREAM_ID}:`)) return undefined;
  const parsed = DiscordPresencePhaseEventSchema.safeParse({
    schemaVersion: 1,
    plane: "semantic",
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    correlationId: event.correlationId,
    sessionId: event.missionId.slice(`${DISCORD_PRESENCE_EVENT_STREAM_ID}:`.length),
    data: event.data,
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * Completed voice stays, derived from the durable phase stream (VUH-940).
 *
 * A stay opens when a guild appears in a session's `voiceGuildIds` and closes
 * when it disappears — including via `process_stopped`/`failed`, which empty
 * the list. Room context (names, occupants) is the one captured at join time;
 * a session killed without a final publication leaves its stay open, and an
 * open stay is simply never reported, because inventing a `leftAt` would be a
 * false record. Newest stays first.
 *
 * This is a read-side projection, not memory: "who was I just with" stays
 * presence-class data about his own whereabouts, and the episode ring
 * (ADR 0054) remains reserved for notes Clankie composes himself.
 */
export function deriveDiscordVoiceHistory(events: readonly DomainEvent[], limit: number): DiscordVoiceStay[] {
  const guildsBySession = new Map<string, ReadonlySet<string>>();
  const openStays = new Map<string, { joinedAt: string; room: DiscordVoiceRoom | undefined }>();
  const closed: DiscordVoiceStay[] = [];
  for (const domainEvent of events) {
    const event = phaseEventFromDomainEvent(domainEvent);
    if (event === undefined) continue;
    const session = event.data.session;
    const nextGuilds = new Set(session.voiceGuildIds);
    const previousGuilds = guildsBySession.get(session.sessionId) ?? new Set<string>();
    for (const guildId of nextGuilds) {
      if (previousGuilds.has(guildId)) continue;
      openStays.set(`${session.sessionId}//${guildId}`, {
        joinedAt: event.occurredAt,
        room: session.voiceRooms?.find((room) => room.guildId === guildId),
      });
    }
    for (const guildId of previousGuilds) {
      if (nextGuilds.has(guildId)) continue;
      const stayKey = `${session.sessionId}//${guildId}`;
      const open = openStays.get(stayKey);
      if (open === undefined) continue;
      openStays.delete(stayKey);
      closed.push({
        guildId,
        ...(open.room?.guildName === undefined ? {} : { guildName: open.room.guildName }),
        ...(open.room?.channelId === undefined ? {} : { channelId: open.room.channelId }),
        ...(open.room?.channelName === undefined ? {} : { channelName: open.room.channelName }),
        occupants: open.room?.occupants ?? [],
        joinedAt: open.joinedAt,
        leftAt: event.occurredAt,
      });
    }
    guildsBySession.set(session.sessionId, nextGuilds);
  }
  return closed.slice(Math.max(0, closed.length - limit)).reverse();
}

function bindingKey(
  identity: Pick<
    DiscordPresenceSessionRecord | DiscordPresenceChannelIdentity,
    "characterId" | "credentialRef" | "transportKind"
  >,
): string {
  return `${identity.transportKind}\u0000${identity.characterId}\u0000${identity.credentialRef}`;
}
