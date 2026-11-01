/**
 * A self-hosted official bot's launch for a room turn (VUH-2835): the turn's
 * own Discord body posts or revokes the Activity invite through its existing
 * `watch_start`/`watch_stop` actions, and its presence write records the launch
 * for admission (ADR 0295).
 */
export interface ActivityRoomLauncher {
  /** The voice channel Clankie's bot occupies in this server, from presence. */
  voiceChannel(guildId: string): Promise<string | undefined>;
  watch(action: "watch_start" | "watch_stop", callId: string): Promise<"confirmed" | "refused" | "uncertain">;
  /** Names a launch before its body call, so a later stop can revoke it. */
  reserve(callId: string, guildId: string, channelId: string): void;
  /** Revokes every reserved launch in this channel, even one whose body call is still running. */
  revoke(guildId: string, channelId: string): void;
  /** Waits, bounded, for revoked launches the body already started; false while any still runs. */
  settle(guildId: string, channelId: string): Promise<boolean>;
}
