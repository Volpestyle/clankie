import { resolveOperatorCredential } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import { SettingsStore, defaultSettingsPath } from "@clankie/settings";

/** Follow is read for each delivery and queued turn; changing it needs no restart. */
export async function runLinearCommand(
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly settings?: SettingsStore } = {},
) {
  const ack = args.length === 3 && args[0] === "inbox" && args[1] === "ack" && /^\d{12}$/u.test(args[2]!);
  if (args[0] === "inbox" && (args.length === 1 || (args.length === 2 && args[1] === "read") || ack)) {
    const env = options.env ?? process.env;
    const credential = await resolveOperatorCredential({ env });
    if (credential === undefined)
      throw new Error("Linear inbox needs the local operator credential. Run clankie doctor.");
    const response = await fetch(`${commandHost({ env })}/v1/linear/inbox`, {
      method: ack ? "POST" : "GET",
      ...(ack ? { body: JSON.stringify({ ackCursor: args[2] }) } : {}),
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
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
    throw new Error("Usage: clankie linear [status] | follow on|off | inbox [read | ack CURSOR]");
  }
  return {
    ok: true as const,
    following: current.linearWebhook.following,
    conversationId: "linear-inbox",
    settingsFile: settings.path,
  };
}
