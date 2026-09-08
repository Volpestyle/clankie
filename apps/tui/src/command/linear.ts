import { SettingsStore, defaultSettingsPath } from "@clankie/settings";

/** Follow is read for each delivery and queued turn; changing it needs no restart. */
export async function runLinearCommand(
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly settings?: SettingsStore } = {},
) {
  const settings = options.settings ?? new SettingsStore(defaultSettingsPath(options.env ?? process.env));
  let current;
  if (args.length === 0 || (args.length === 1 && args[0] === "status")) {
    current = await settings.load();
  } else if (args.length === 2 && args[0] === "follow" && (args[1] === "on" || args[1] === "off")) {
    current = await settings.update((value) => ({
      ...value,
      linearWebhook: { following: args[1] === "on" },
    }));
  } else {
    throw new Error("Usage: clankie linear [status] | follow on|off");
  }
  return {
    ok: true as const,
    following: current.linearWebhook.following,
    conversationId: "linear-inbox",
    settingsFile: settings.path,
  };
}
