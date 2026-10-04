import { SettingsStore, defaultSettingsPath, DesktopSettingsSchema } from "@clankie/settings";

const DESKTOP_USAGE =
  "Usage: clankie desktop [status]\n       clankie desktop quiet-hours START END TIME_ZONE\n       clankie desktop quiet-hours off";
export async function runDesktopCommand(
  args: readonly string[],
  options: { readonly settings?: SettingsStore; readonly env?: NodeJS.ProcessEnv } = {},
) {
  const settings = options.settings ?? new SettingsStore(defaultSettingsPath(options.env ?? process.env));
  let current = await settings.load();
  if (args.length === 0 || (args.length === 1 && args[0] === "status")) {
    return { ok: true as const, desktop: current.desktop, settingsFile: settings.path };
  }
  if (args[0] !== "quiet-hours") throw new Error(DESKTOP_USAGE);
  const desktop =
    args.length === 2 && args[1] === "off"
      ? DesktopSettingsSchema.parse({})
      : args.length === 4
        ? DesktopSettingsSchema.parse({ quietHours: { start: args[1], end: args[2], timeZone: args[3] } })
        : undefined;
  if (desktop === undefined) throw new Error(DESKTOP_USAGE);
  current = await settings.update((value) => ({ ...value, desktop }));
  return { ok: true as const, desktop: current.desktop, settingsFile: settings.path };
}
