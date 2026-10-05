import {
  DISCORD_SETUP_DEFINITION,
  type DiscordSetupSnapshot,
  type DiscordSettings,
  type DiscordPermissionsRequest,
  type DiscordPermissionsSnapshot,
} from "@clankie/protocol";

export async function discordSetupChecks(
  settings: DiscordSettings,
  read: (query: DiscordPermissionsRequest) => Promise<DiscordPermissionsSnapshot>,
): Promise<NonNullable<DiscordSetupSnapshot["checks"]>> {
  const talk = DISCORD_SETUP_DEFINITION.sentences.find((sentence) => sentence.id === "talk")!;
  const ids = [
    ...new Set(
      talk.parts.flatMap((part) =>
        part.kind === "picker"
          ? part.fields.flatMap((field) =>
              Array.isArray(settings[field]) ? (settings[field] as string[]) : [],
            )
          : [],
      ),
    ),
  ];
  const selected = await Promise.all(ids.slice(0, 100).map((channelId) => read({ channelId })));
  const status = (values: string[]) =>
    values.includes("failed")
      ? ("failed" as const)
      : !values.length || values.includes("not_checked")
        ? ("not_checked" as const)
        : ("passed" as const);
  const checks: NonNullable<DiscordSetupSnapshot["checks"]> = (
    ["view_channel", "send_messages"] as const
  ).map((kind) => ({
    sentenceId: "talk",
    kind,
    status: status([
      ...selected.map((value) => value.permissions[kind]),
      ...(ids.length > 100 ? ["not_checked"] : []),
    ]),
  }));
  const teamGuild = settings.swarmGuildId;
  const team = teamGuild ? await read({ guildId: teamGuild }) : undefined;
  checks.push({
    sentenceId: "team",
    kind: "manage_channels",
    status: team?.permissions.manage_channels ?? "not_checked",
  });
  // Creating rooms is guild-scoped. Posting/webhooks need evidence from actual
  // selected rooms in that server; a guild role alone cannot prove overwrites.
  const rooms = selected.filter((value) => value.guildId === teamGuild);
  for (const kind of ["send_messages", "manage_webhooks"] as const)
    checks.push({ sentenceId: "team", kind, status: status(rooms.map((value) => value.permissions[kind])) });
  const actors = new Set(
    [...selected, ...(team ? [team] : [])].flatMap((value) =>
      value.actorId ? [`${value.body}:${value.actorId}`] : [],
    ),
  );
  if (actors.size > 1) for (const check of checks) check.status = "not_checked";
  return checks;
}
