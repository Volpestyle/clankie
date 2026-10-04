import { parseArgs } from "node:util";
import {
  DiscordSetupClient,
  discordSetupPickers,
  discordSetupLabel,
  discordPickerEntries,
  discordPickByName,
  discordDirectoryEntryLabel,
  type DiscordSetupApi,
  type DiscordAccessChoice,
} from "@clankie/api-client";

const USAGE =
  "Use discord setup [choices home|talk|computer|team], or discord setup home --server NAME; talk --channel NAME [...]; computer --access nobody|me|people|servers [--person NAME | --server NAME ...]; team [--visible on|off] [--server NAME].";
export async function runDiscordSetupCommand(args: readonly string[], api: DiscordSetupApi) {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      server: { type: "string", multiple: true },
      channel: { type: "string", multiple: true },
      person: { type: "string", multiple: true },
      access: { type: "string" },
      visible: { type: "string" },
    },
  });
  const client = new DiscordSetupClient(api);
  let view = await client.read();
  if (!args.length) return view;
  const listing = positionals[0] === "choices";
  const id = positionals[listing ? 1 : 0];
  const sentence = view.snapshot.setup!.definition.sentences.find((item) => item.id === id);
  if (!sentence || positionals.length !== (listing ? 2 : 1)) throw new Error(USAGE);
  const pickers = discordSetupPickers(sentence);
  if (listing) {
    if (Object.keys(values).length) throw new Error(USAGE);
    return {
      sentence: view.sentences.find((item) => item.id === id),
      pickers: pickers.map((part) => ({
        kind: part.picker,
        placeholder: part.placeholder,
        choices:
          part.picker === "team_visibility"
            ? [
                { choice: "on", name: discordSetupLabel(view.snapshot, "team_visible") },
                { choice: "off", name: discordSetupLabel(view.snapshot, "team_hidden") },
              ]
            : part.picker === "computer_access"
              ? [
                  ["nobody", "deny"],
                  ["me", "owner_only"],
                  ["people", "allowlist"],
                  ["servers", "guild_members"],
                ].map(([choice, key]) => ({ choice, name: discordSetupLabel(view.snapshot, key!) }))
              : discordPickerEntries(view, part).map((entry, index) => ({
                  choice: `@${index + 1}`,
                  name: discordDirectoryEntryLabel(view, entry),
                })),
        ...(part.picker === "computer_access"
          ? {
              people: discordPickerEntries(view, part, "allowlist").map((entry, index) => ({
                choice: `@${index + 1}`,
                name: discordDirectoryEntryLabel(view, entry),
              })),
              servers: discordPickerEntries(view, part, "guild_members").map((entry, index) => ({
                choice: `@${index + 1}`,
                name: discordDirectoryEntryLabel(view, entry),
              })),
            }
          : {}),
      })),
      directories: view.directories.map(({ kind, state, reason }) => ({ kind, state, reason })),
    };
  }
  const allowed = new Set(
    pickers.flatMap((part) =>
      part.picker === "server"
        ? ["server"]
        : part.picker === "channels"
          ? ["channel"]
          : part.picker === "computer_access"
            ? ["access", "person", "server"]
            : ["visible"],
    ),
  );
  if (!Object.keys(values).length || Object.keys(values).some((key) => !allowed.has(key)))
    throw new Error(USAGE);
  const selections = pickers.map((part) => {
    if (part.picker === "team_visibility") {
      if (values.visible === undefined) return undefined;
      if (!["on", "off"].includes(values.visible)) throw new Error(USAGE);
      return { visible: values.visible === "on" };
    }
    if (part.picker === "computer_access") {
      const modes: Record<string, DiscordAccessChoice> = {
        nobody: "deny",
        me: "owner_only",
        people: "allowlist",
        servers: "guild_members",
      };
      const access = modes[values.access ?? ""];
      if (
        !access ||
        values.channel ||
        (access !== "allowlist" && values.person) ||
        (access !== "guild_members" && values.server)
      )
        throw new Error(USAGE);
      const names =
        access === "allowlist"
          ? (values.person ?? [])
          : access === "guild_members"
            ? (values.server ?? [])
            : [];
      if ((access === "allowlist" || access === "guild_members") && !names.length) throw new Error(USAGE);
      const choices = discordPickerEntries(view, part, access);
      return { access, ids: names.map((name) => discordPickByName(view, choices, name).id) };
    }
    const names = part.picker === "server" ? values.server : values.channel;
    if (!names) return undefined;
    if (part.picker === "server" && names.length !== 1) throw new Error(USAGE);
    const choices = discordPickerEntries(view, part);
    return { ids: names.map((name) => discordPickByName(view, choices, name).id) };
  });
  view = await client.applySentence(
    view,
    sentence.id,
    selections.flatMap((selection, pickerIndex) => (selection ? [{ pickerIndex, selection }] : [])),
  );
  return { ...view, restart: "Restart the Discord connection to apply saved server and room choices." };
}
