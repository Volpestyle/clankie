import type { CaptainSessionLaneV2 } from "@clankie/protocol";

/**
 * Which optional services this install has set up. A service that is not set
 * up keeps its tools registered but out of the model's request, so a fresh
 * install does not pay for schemas it cannot use (VUH-2647: they were a large
 * share of a local model's first request). Its tools return on the next run
 * after it is set up; nothing restarts.
 */
export interface ServiceReadiness {
  /**
   * At least one Minecraft server profile is saved: `minecraft_configure`, or a
   * first hosted start, which saves `clankie-hosted`.
   */
  readonly minecraft: boolean;
  /** A Discord body (bot or user session) has its credential and is in this install's loadout. */
  readonly discordBody: boolean;
  /** A mailbox is connected: IMAP credentials, or Clankie's own address. */
  readonly mailbox: boolean;
  /** The tracker is the owner's connected Linear, not the built-in fallback. */
  readonly linear: boolean;
}

const DISCORD_BODY_TOOLS: ReadonlySet<string> = new Set([
  "voice_join",
  "voice_leave",
  "music_now",
  "music_pause",
  "music_play",
  "music_queue",
  "music_resume",
  "music_skip",
  "music_stop",
  "youtube_search",
  "discord_server_action",
  "discord_tracking_project",
  "activity_share",
  "observe_share",
]);
const MAILBOX_TOOLS: ReadonlySet<string> = new Set([
  "email_list",
  "email_read",
  "email_search",
  "email_send",
]);

/**
 * How Clankie sets a world up with its owner (the `minecraft` skill), so they
 * stay listed before any profile exists. Play and administration wait for one.
 */
const MINECRAFT_SETUP_TOOLS: ReadonlySet<string> = new Set([
  "minecraft_configure",
  "minecraft_configuration",
  "minecraft_host_configure",
  "minecraft_host_configuration",
  "minecraft_host_status",
  "minecraft_host_lifecycle",
  "minecraft_host_claim",
  "minecraft_host_claim_status",
  "minecraft_host_claim_complete",
]);

/** The service a tool needs on this lane, if any. A Discord lane is itself the Discord body. */
function serviceOf(name: string, lane: CaptainSessionLaneV2): keyof ServiceReadiness | undefined {
  if (name.startsWith("minecraft_")) return MINECRAFT_SETUP_TOOLS.has(name) ? undefined : "minecraft";
  if (DISCORD_BODY_TOOLS.has(name)) return lane.startsWith("discord_") ? undefined : "discordBody";
  if (MAILBOX_TOOLS.has(name)) return "mailbox";
  if (name === "linear_wake") return "linear";
  return undefined;
}

/**
 * The next active tool list. Tools whose service is not set up are dropped and
 * remembered in `withheld`; withheld tools come back once their service is set
 * up. Every other activation (`mcp_tool_search`, a Discord allowlist) is kept as
 * it is, and a tool this gate never withheld is never added.
 */
export function gateServiceTools(
  active: readonly string[],
  registered: ReadonlySet<string>,
  readiness: ServiceReadiness,
  lane: CaptainSessionLaneV2,
  withheld: Set<string>,
): string[] {
  const ready = (name: string): boolean => {
    const service = serviceOf(name, lane);
    return service === undefined || readiness[service];
  };
  const next = active.filter((name) => {
    if (ready(name)) return true;
    withheld.add(name);
    return false;
  });
  for (const name of withheld) {
    if (!ready(name) || !registered.has(name)) continue;
    withheld.delete(name);
    if (!next.includes(name)) next.push(name);
  }
  return next;
}
