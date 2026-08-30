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
   * Make the guild channel and its webhook for a Clankie channel (ADR 0146).
   * This is provisioning inside a guild the owner already approved — never
   * guild creation — and it lives here because the bot token that can do it
   * belongs to the trusted runtime module: the service asks for a room and is
   * handed one, rather than holding the credential that makes one.
   *
   * Absent on an older runtime module, which leaves the pasted-webhook path.
   */
  provisionChannel?(input: { readonly name: string; readonly topic?: string }): Promise<{
    readonly guildId: string;
    readonly channelId: string;
    readonly webhookId: string;
    readonly webhookToken: string;
  }>;
}
