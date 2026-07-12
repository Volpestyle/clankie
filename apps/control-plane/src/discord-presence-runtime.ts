import type { DiscordPresenceWrite, DiscordPresenceWriteResult } from "@clankie/protocol";

/**
 * Privileged Discord presence executor. Credentials stay inside the trusted
 * runtime module; the control plane only passes policy-allowed writes (ADR 0024).
 */
export interface DiscordPresenceRuntimePort {
  execute(write: DiscordPresenceWrite): Promise<DiscordPresenceWriteResult>;
}
