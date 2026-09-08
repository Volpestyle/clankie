import { resolveOperatorCredential } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import { SettingsStore, defaultSettingsPath } from "@clankie/settings";

/** Follow is read for each delivery and queued turn; changing it needs no restart. */
export async function runLinearCommand(
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly settings?: SettingsStore } = {},
) {
  if (args[0] === "inbox" && (args.length === 1 || (args.length === 2 && args[1] === "read"))) {
    const env = options.env ?? process.env;
    const credential = await resolveOperatorCredential({ env });
    if (credential === undefined)
      throw new Error("Linear inbox needs the local operator credential. Run clankie doctor.");
    const response = await fetch(`${commandHost({ env })}/v1/linear/inbox`, {
      method: args[1] === "read" ? "POST" : "GET",
      headers: { authorization: `Bearer ${credential.token}` },
    });
    if (!response.ok) throw new Error(`Linear inbox failed: ${response.status}`);
    return response.json();
  }
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
    throw new Error("Usage: clankie linear [status] | follow on|off | inbox [read]");
  }
  return {
    ok: true as const,
    following: current.linearWebhook.following,
    conversationId: "linear-inbox",
    settingsFile: settings.path,
  };
}
