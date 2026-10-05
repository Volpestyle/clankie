import { parseArgs } from "node:util";
import {
  DiscordSetupClient,
  discordSetupPickers,
  discordSetupLabel,
  discordPickerEntries,
  discordPickByName,
  discordDirectoryEntryLabel,
  type DiscordSetupApi,
  type DiscordPickerSelection,
} from "@clankie/api-client";

const USAGE =
  "Use discord setup [check | choices connect|fleet|tracking], connect [--server NAME] [--role participant|admin], invite [--role participant|admin], fleet --enabled on|off, tracking --level off|project_updates|project_activity|all_issues, or test-post --channel NAME. Raw IDs belong in discord set (Advanced).";
export async function runDiscordSetupCommand(args: readonly string[], api: DiscordSetupApi) {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      server: { type: "string" },
      role: { type: "string" },
      enabled: { type: "string" },
      level: { type: "string" },
      channel: { type: "string" },
    },
  });
  const client = new DiscordSetupClient(api);
  let view = await client.read();
  if (!args.length || (positionals[0] === "check" && positionals.length === 1 && !Object.keys(values).length))
    return view;
  if (positionals[0] === "invite") {
    if (positionals.length !== 1 || Object.keys(values).some((key) => key !== "role")) throw new Error(USAGE);
    if (values.role) {
      const connect = view.snapshot.setup!.definition.sentences.find((sentence) => sentence.id === "connect");
      const pickerIndex = connect && discordSetupPickers(connect).findIndex((part) => part.picker === "role");
      if (pickerIndex === undefined || pickerIndex < 0)
        throw new Error("This host does not offer the server role setup model.");
      view = await client.apply(view, "connect", pickerIndex, { value: values.role });
    }
    if (!view.snapshot.setup!.invite)
      throw new Error("Set the bot Application ID in Advanced before creating its invite link.");
    return view.snapshot.setup!.invite;
  }
  if (positionals[0] === "test-post") {
    if (positionals.length !== 1 || !values.channel || Object.keys(values).some((key) => key !== "channel"))
      throw new Error(USAGE);
    view = await client.testRooms(view);
    const rooms = view.directories
      .filter((directory) => directory.kind === "channels")
      .flatMap((directory) => directory.entries)
      .filter((entry) => ["text", "announcement"].includes(entry.kind));
    return client.testPost(view, discordPickByName(view, rooms, values.channel));
  }
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
        choices: part.choices
          ? part.choices.map((choice) => ({ choice, name: discordSetupLabel(view.snapshot, choice) }))
          : discordPickerEntries(view, part).map((entry, index) => ({
              choice: `@${index + 1}`,
              name: discordDirectoryEntryLabel(view, entry),
            })),
      })),
      directories: view.directories.map(({ kind, state, reason }) => ({ kind, state, reason })),
    };
  }
  const flag = (picker: string) =>
    picker === "server" ? "server" : picker === "role" ? "role" : picker === "fleet" ? "enabled" : "level";
  const allowed = new Set<string>(pickers.map((part) => flag(part.picker)));
  if (!Object.keys(values).length || Object.keys(values).some((key) => !allowed.has(key)))
    throw new Error(USAGE);
  const selections: { pickerIndex: number; selection: DiscordPickerSelection }[] = [];
  for (const [pickerIndex, part] of pickers.entries()) {
    const value = values[flag(part.picker)];
    if (!value) continue;
    selections.push({
      pickerIndex,
      selection:
        part.picker === "server"
          ? { ids: [discordPickByName(view, discordPickerEntries(view, part), value).id] }
          : { value },
    });
  }
  view = await client.applySentence(view, sentence.id, selections);
  return { ...view, restart: "Restart the Discord connection to apply saved server and role changes." };
}
