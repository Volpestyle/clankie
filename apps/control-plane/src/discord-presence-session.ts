import {
  DiscordPresencePhaseEventSchema,
  type DiscordPresencePhaseEvent,
  type DiscordPresenceSessionRecord,
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
    return this.project(event, true);
  }

  public validate(event: DiscordPresencePhaseEvent): DiscordPresenceSessionRecord {
    return this.project(event, false);
  }

  private project(event: DiscordPresencePhaseEvent, commit: boolean): DiscordPresenceSessionRecord {
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
      if (commit) this.sessions.set(key, structuredClone(session));
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
      if (commit) this.sessions.set(key, structuredClone(session));
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
    if (session.revision !== previous.revision + 1) {
      throw new Error("discord_presence_session_revision_gap");
    }
    if (parsed.data.previousPhase !== previous.phase) {
      throw new Error("discord_presence_session_previous_phase_conflict");
    }
    if (commit) this.sessions.set(key, structuredClone(session));
    return structuredClone(session);
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

function bindingKey(
  identity: Pick<
    DiscordPresenceSessionRecord | DiscordPresenceChannelIdentity,
    "characterId" | "credentialRef" | "transportKind"
  >,
): string {
  return `${identity.transportKind}\u0000${identity.characterId}\u0000${identity.credentialRef}`;
}
