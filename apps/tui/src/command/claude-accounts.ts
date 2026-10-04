import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultSettingsPath, SettingsStore } from "@clankie/settings";

/** Register existing owner profiles only; never reads credentials or changes login. */
export async function runClaudeAccountsCommand(
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; settings?: SettingsStore } = {},
) {
  const env = options.env ?? process.env;
  const store = options.settings ?? new SettingsStore(defaultSettingsPath(env));
  const [verb, value, flag, label] = args;
  if (verb === "add" && value && flag === "--label" && label && args.length === 4) {
    if (label === "default") throw new Error("default is the implicit Claude profile; use another label");
    const home = await realpath(value);
    if (!(await stat(home)).isDirectory())
      throw new Error("Claude profile home must be an existing directory");
    await store.update((current) => ({
      ...current,
      claudeAccounts: [...current.claudeAccounts.filter((a) => a.label !== label), { label, home }],
    }));
  } else if (verb === "remove" && value && args.length === 2) {
    if (value === "default") throw new Error("The default Claude profile cannot be removed");
    await store.update((current) => ({
      ...current,
      claudeAccounts: current.claudeAccounts.filter((a) => a.label !== value),
    }));
  } else if (args.length && !(args.length === 1 && verb === "list"))
    throw new Error("Usage: clankie accounts claude [list | add HOME --label LABEL | remove LABEL]");
  return {
    ok: true,
    accounts: [
      { label: "default", home: env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude") },
      ...(await store.load()).claudeAccounts,
    ],
    settingsFile: store.path,
  };
}
