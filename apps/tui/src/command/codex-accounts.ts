import {
  registerCodexAccount,
  removeCodexAccount,
  codexAccounts,
  codexAccountStatus,
  defaultSettingsPath,
  SettingsStore,
} from "@clankie/settings";

export async function runCodexAccountsCommand(
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; settings?: SettingsStore } = {},
) {
  const env = options.env ?? process.env;
  const store = options.settings ?? new SettingsStore(defaultSettingsPath(env));
  const [verb, value, flag, label] = args;
  if (verb === "add" && value && flag === "--label" && label && args.length === 4) {
    await registerCodexAccount(store, { label, home: value }, env);
  } else if (verb === "remove" && value && args.length === 2) {
    await removeCodexAccount(store, value);
  } else if (args.length && !(args.length === 1 && verb === "list")) {
    throw new Error("Usage: clankie accounts codex [list | add HOME --label LABEL | remove LABEL]");
  }
  return {
    ok: true,
    accounts: codexAccounts(await store.load(), env).map((account) => codexAccountStatus(account)),
    settingsFile: store.path,
  };
}
