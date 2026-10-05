import {
  discordSetupDefinition,
  type DiscordSetupSnapshot,
  type DiscordSettings,
  type DiscordPermissionsRequest,
  type DiscordPermissionsSnapshot,
} from "@clankie/protocol";

/** Verify the role’s server grants; channel overwrites remain Discord’s participation policy. */
export async function discordSetupChecks(
  settings: DiscordSettings,
  read: (query: DiscordPermissionsRequest) => Promise<DiscordPermissionsSnapshot>,
): Promise<NonNullable<DiscordSetupSnapshot["checks"]>> {
  const server = settings.serverId ? await read({ guildId: settings.serverId }) : undefined;
  const verified = server?.actorId && server.guildId === settings.serverId ? server : undefined;
  const connect = discordSetupDefinition(settings).sentences.find((sentence) => sentence.id === "connect")!;
  const checks: NonNullable<DiscordSetupSnapshot["checks"]> = connect.checks
    .filter((kind) => kind !== "account")
    .map((kind) => ({
      sentenceId: "connect",
      kind: kind as keyof DiscordPermissionsSnapshot["permissions"],
      status: verified?.permissions[kind as keyof DiscordPermissionsSnapshot["permissions"]] ?? "not_checked",
    }));
  if (settings.fleetEnabled && settings.role === "participant") {
    const room = settings.fleetChannelId
      ? await read({ guildId: settings.serverId, channelId: settings.fleetChannelId })
      : undefined;
    const available = !!(
      settings.serverId &&
      room?.actorId &&
      room.guildId === settings.serverId &&
      room.channelId === settings.fleetChannelId
    );
    checks.push({
      sentenceId: "fleet",
      kind: "fleet_channel",
      status: !settings.fleetChannelId ? "failed" : available ? "passed" : "not_checked",
    });
    checks.push({
      sentenceId: "fleet",
      kind: "send_messages",
      status: available ? room!.permissions.send_messages : "not_checked",
    });
    if (verified && room?.actorId && (room.actorId !== verified.actorId || room.body !== verified.body))
      for (const check of checks) check.status = "not_checked";
  }
  return checks;
}
