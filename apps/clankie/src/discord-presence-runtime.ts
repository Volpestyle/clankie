import type { DiscordPresenceSessionRecord } from "@clankie/interactive-environment";
import type {
  DiscordGuildRoom,
  DiscordGuildRoomTarget,
  DiscordPresenceWrite,
  DiscordPresenceWriteResult,
} from "@clankie/protocol";

/**
 * Privileged Discord presence executor. Credentials stay inside the trusted
 * runtime module; the service only passes policy-allowed writes (ADR 0024).
 */
export interface DiscordPresenceRuntimePort {
  execute(
    write: DiscordPresenceWrite,
    session: DiscordPresenceSessionRecord,
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
   * same module answers for the swarm home, so without it nothing projects.
   * The manual path is for a runtime that is here and simply lacks
   * `Manage Webhooks` in the swarm home.
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
   * The swarm home's rooms, so projecting onto one the owner already made is a
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
