/** Core-owned reads and admitted writes of the persona (ADR 0328). */
import type {
  DiscordPresencePhaseEvent,
  DiscordPresenceSessionRecord,
  DiscordVoiceStay,
} from "@clankie/interactive-environment";
import type {
  BodyVoiceTarget,
  DiscordGuildRoom,
  DiscordGuildRoomTarget,
  DiscordPresenceChannelIdentity,
  DiscordPresenceWrite,
  DiscordPresenceWriteResult,
  DiscordServerAction,
  DiscordServerActionResult,
  DiscordUserSessionOptIn,
  DomainEvent,
  DiscordVoiceTranscriptLogEntry,
  DiscordRoomEvidence,
  DiscordRoomGuidance,
  DiscordRoomStatus,
  DiscordDirectoryRequest,
  DiscordDirectorySnapshot,
  DiscordPermissionsRequest,
  DiscordPermissionsSnapshot,
  DiscordBodyTestPostRequest,
  DiscordSetupTestPostResult,
} from "@clankie/protocol";

export interface PresenceState {
  readonly sessions: {
    apply(event: DiscordPresencePhaseEvent): DiscordPresenceSessionRecord;
    resolve(
      identity: Pick<DiscordPresenceChannelIdentity, "characterId" | "credentialRef" | "transportKind">,
    ): DiscordPresenceSessionRecord | undefined;
    list(): DiscordPresenceSessionRecord[];
  };
  readonly optIns: {
    apply(event: DomainEvent): void;
    resolve(): DiscordUserSessionOptIn | undefined;
    resolveActive(profileHash: string): DiscordUserSessionOptIn | undefined;
  };
  readonly voiceHistory: { apply(event: DomainEvent): void; list(limit: number): DiscordVoiceStay[] };
  readonly transcripts: VoiceTranscriptReadPort;
}

export interface PresenceStateFactory {
  retiredEventIds(events: readonly DomainEvent[]): Set<string>;
  replay(events: readonly DomainEvent[]): PresenceState;
}

export interface VoiceTranscriptReadPort {
  read(
    afterCursor?: string,
    limit?: number,
  ): Promise<{
    readonly entries: readonly DiscordVoiceTranscriptLogEntry[];
    readonly nextCursor: string;
    readonly hasMore: boolean;
  }>;
}

export interface RoomObservationsPort {
  observeFailures(listener: (conversationId: string) => void): () => void;
  status(conversationId: string): DiscordRoomStatus;
  list(): DiscordRoomStatus[];
  record(conversationId: string, evidence: DiscordRoomEvidence): void;
  setGuidance(
    conversationId: string,
    text: string | undefined,
    expectedRevision: number,
    guard: () => Promise<void>,
    current?: () => boolean,
  ): DiscordRoomGuidance;
}

export interface RoomSetupPort {
  directory?(
    query: DiscordDirectoryRequest,
    body: DiscordDirectorySnapshot["body"],
  ): Promise<DiscordDirectorySnapshot>;
  permissions?(
    query: DiscordPermissionsRequest,
    body: DiscordDirectorySnapshot["body"],
  ): Promise<DiscordPermissionsSnapshot>;
  testPost?(
    query: DiscordBodyTestPostRequest,
    body: DiscordDirectorySnapshot["body"],
  ): Promise<DiscordSetupTestPostResult>;
}

/** Empty reads and refused writes while the persona is absent. Never reconstructs authority. */
export function absentPresenceState(): PresenceState {
  const unavailable = (): never => {
    throw new Error("persona_unavailable");
  };
  return {
    sessions: { apply: unavailable, resolve: () => undefined, list: () => [] },
    optIns: { apply: unavailable, resolve: () => undefined, resolveActive: () => undefined },
    voiceHistory: { apply: () => {}, list: () => [] },
    transcripts: { read: async () => ({ entries: [], nextCursor: "000000000000", hasMore: false }) },
  };
}

/**
 * Privileged Discord presence executor. Credentials stay inside the trusted
 * runtime module; the service only passes policy-allowed writes (ADR 0024).
 */
export interface DiscordPresenceRuntimePort {
  /** Native server REST: configured role and server are enforced inside the body. */
  serverAction?(input: DiscordServerAction): Promise<DiscordServerActionResult>;
  /** null proves no reply exists; errors preserve uncertainty. Read-only. */
  reconcileReply?(write: DiscordPresenceWrite): Promise<DiscordPresenceWriteResult | null>;
  execute(
    write: DiscordPresenceWrite,
    session: DiscordPresenceSessionRecord,
    guard?: (() => Promise<void>) & {
      readonly publish?: {
        readonly ticket?: string;
        readonly stayId?: string;
        readonly target: BodyVoiceTarget;
      };
    },
  ): Promise<DiscordPresenceWriteResult>;
  /**
   * Make the webhook for a Clankie channel, plus either its guild channel when
   * no container is named or its post when a forum is selected (ADR 0146).
   * This is provisioning inside a guild the
   * owner already approved — never guild creation — and it lives here because
   * the bot token that can do it
   * belongs to the trusted runtime module: the service asks for a room and is
   * handed one, rather than holding the credential that makes one.
   *
   * Absent on an older runtime module. That is not a fallback to pasting: the
   * same module answers for the managed server, so without it nothing projects.
   * The manual path is for a runtime that is here and simply lacks
   * `Manage Webhooks` in the managed server.
   */
  provisionChannel?(input: {
    readonly name: string;
    readonly topic?: string;
    /** An existing container in the home guild; absent makes a text channel. */
    readonly room?: DiscordGuildRoomTarget;
  }): Promise<{
    readonly guildId: string;
    /** The direct channel, or the parent forum that owns the webhook. */
    readonly channelId: string;
    /** The forum post carrying the room, when a forum was selected. */
    readonly threadId?: string;
    readonly webhookId: string;
    readonly webhookToken: string;
  }>;
  /**
   * The managed server's rooms, so projecting onto one the owner already made is a
   * pick rather than a webhook URL copied out of Server Settings.
   */
  listRooms?(): Promise<readonly DiscordGuildRoom[]>;
  /**
   * The one server Clankie controls and may put his agents in. Distinct from
   * the command server: a guild he merely inhabits may be on every ingress,
   * presence, and voice allowlist and still never host a room.
   */
  swarmGuildId?(): string | undefined;
}
