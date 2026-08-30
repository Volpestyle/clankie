import type { DiscordPresenceSessionRecord } from "@clankie/interactive-environment";
import type { DiscordPresenceWrite, DiscordPresenceWriteResult } from "@clankie/protocol";

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
   * Make the webhook for a Clankie channel, and the guild channel too when no
   * existing one is named (ADR 0146). This is provisioning inside a guild the
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
    /** An existing room in the home guild; absent makes a new one. */
    readonly channelId?: string;
  }): Promise<{
    readonly guildId: string;
    readonly channelId: string;
    readonly webhookId: string;
    readonly webhookToken: string;
  }>;
  /**
   * The swarm home's rooms, so projecting onto one the owner already made is a
   * pick rather than a webhook URL copied out of Server Settings.
   */
  listRooms?(): Promise<readonly { readonly channelId: string; readonly name: string }[]>;
  /**
   * The one server Clankie controls and may put his agents in. Distinct from
   * the command server: a guild he merely inhabits may be on every ingress,
   * presence, and voice allowlist and still never host a room.
   */
  swarmGuildId?(): string | undefined;
}
