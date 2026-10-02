import {
  DiscordPresencePhaseEventSchema,
  DiscordPresenceSessionRecordSchema,
  type DiscordPresencePhaseEvent,
  type DiscordPresenceSessionRecord,
  type DiscordVoiceRoom,
  type DiscordVoiceStay,
} from "@clankie/interactive-environment";
import type { DiscordPresenceChannelIdentity, DomainEvent } from "@clankie/protocol";

const DISCORD_PRESENCE_EVENT_STREAM_ID = "discord-presence" as const;

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

/** The most stays anyone may ask for; the history holds exactly this many. */
export const DISCORD_VOICE_HISTORY_LIMIT_MAX = 32;

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
 * Folded as events arrive, so it holds only the newest closed stays, the open
 * ones, and the guilds of sessions currently in voice — not the whole stream.
 *
 * This is a read-side projection, not memory: "who was I just with" stays
 * presence-class data about his own whereabouts, and the episode ring
 * (ADR 0054) remains reserved for notes Clankie composes himself.
 */
export class DiscordVoiceHistoryProjection {
  private readonly latestSessionByBinding = new Map<string, string>();
  private readonly guildsBySession = new Map<string, ReadonlySet<string>>();
  private readonly openStays = new Map<string, { joinedAt: string; room: DiscordVoiceRoom | undefined }>();
  /** Oldest first, each with the session that produced it. */
  private readonly closed: { readonly sessionId: string; readonly stay: DiscordVoiceStay }[] = [];

  public constructor(events: readonly DomainEvent[] = []) {
    for (const event of events) this.apply(event);
  }

  public apply(domainEvent: DomainEvent): void {
    const event = phaseEventFromDomainEvent(domainEvent);
    if (event === undefined) return;
    const session = event.data.session;
    const binding = bindingKey(session);
    const previousSession = this.latestSessionByBinding.get(binding);
    if (previousSession !== undefined && previousSession !== session.sessionId) {
      // A crashed process can leave voice without a final event. Its unfinished
      // stays cannot close in the replacement session and must not accumulate.
      for (const guildId of this.guildsBySession.get(previousSession) ?? []) {
        this.openStays.delete(`${previousSession}//${guildId}`);
      }
      this.guildsBySession.delete(previousSession);
    }
    this.latestSessionByBinding.set(binding, session.sessionId);
    const nextGuilds = new Set(session.voiceGuildIds);
    const previousGuilds = this.guildsBySession.get(session.sessionId) ?? new Set<string>();
    for (const guildId of nextGuilds) {
      if (previousGuilds.has(guildId)) continue;
      this.openStays.set(`${session.sessionId}//${guildId}`, {
        joinedAt: event.occurredAt,
        room: session.voiceRooms?.find((room) => room.guildId === guildId),
      });
    }
    for (const guildId of previousGuilds) {
      if (nextGuilds.has(guildId)) continue;
      const stayKey = `${session.sessionId}//${guildId}`;
      const open = this.openStays.get(stayKey);
      if (open === undefined) continue;
      this.openStays.delete(stayKey);
      this.closed.push({
        sessionId: session.sessionId,
        stay: {
          guildId,
          ...(open.room?.guildName === undefined ? {} : { guildName: open.room.guildName }),
          ...(open.room?.channelId === undefined ? {} : { channelId: open.room.channelId }),
          ...(open.room?.channelName === undefined ? {} : { channelName: open.room.channelName }),
          occupants: open.room?.occupants ?? [],
          joinedAt: open.joinedAt,
          leftAt: event.occurredAt,
        },
      });
      if (this.closed.length > DISCORD_VOICE_HISTORY_LIMIT_MAX) this.closed.shift();
    }
    // A session out of voice is the same as one never seen.
    if (nextGuilds.size === 0) this.guildsBySession.delete(session.sessionId);
    else this.guildsBySession.set(session.sessionId, nextGuilds);
  }

  public list(limit: number): DiscordVoiceStay[] {
    return this.closed
      .slice(Math.max(0, this.closed.length - limit))
      .map(({ stay }) => structuredClone(stay))
      .reverse();
  }

  /** Sessions whose phase events the reported stays were derived from. */
  public sessionIds(): ReadonlySet<string> {
    return new Set(this.closed.map(({ sessionId }) => sessionId));
  }
}

/**
 * Phase events a durable log may drop without changing anything replay builds.
 *
 * Retirement is by whole session, because the session projection refuses a
 * binding whose first event is not a `process_start` at revision 1. Kept: every
 * event of each binding's latest session (so the session projection replays to
 * the same records and revisions), and every event of a session behind one of
 * the newest {@link DISCORD_VOICE_HISTORY_LIMIT_MAX} closed voice stays (so voice
 * history reads the same). Everything else is an ended session's history.
 */
export function retiredDiscordPresenceEventIds(events: readonly DomainEvent[]): Set<string> {
  const latestSessionByBinding = new Map<string, string>();
  const history = new DiscordVoiceHistoryProjection();
  const phases: { readonly id: string; readonly sessionId: string }[] = [];
  for (const domainEvent of events) {
    const event = phaseEventFromDomainEvent(domainEvent);
    if (event === undefined) continue;
    const session = event.data.session;
    latestSessionByBinding.set(bindingKey(session), session.sessionId);
    history.apply(domainEvent);
    phases.push({ id: domainEvent.id, sessionId: session.sessionId });
  }
  const kept = new Set([...latestSessionByBinding.values(), ...history.sessionIds()]);
  return new Set(phases.flatMap(({ id, sessionId }) => (kept.has(sessionId) ? [] : [id])));
}

function bindingKey(
  identity: Pick<
    DiscordPresenceSessionRecord | DiscordPresenceChannelIdentity,
    "characterId" | "credentialRef" | "transportKind"
  >,
): string {
  return `${identity.transportKind}\u0000${identity.characterId}\u0000${identity.credentialRef}`;
}
