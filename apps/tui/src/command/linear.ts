import { resolveOperatorCredential } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import { SettingsStore, defaultSettingsPath } from "@clankie/settings";

const LINEAR_USAGE =
  "Usage: clankie linear [status] | follow on|off | inbox [read [--limit N] [--before CURSOR] [--headlines] | ack CURSOR]";

/** The query string for `inbox read` flags; `undefined` when a flag is malformed. */
export function parseInboxRead(flags: readonly string[]): string | undefined {
  const query = new URLSearchParams();
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    if (flag === "--headlines") query.set("headlines", "1");
    else if ((flag === "--limit" || flag === "--before") && flags[i + 1] !== undefined) {
      const value = flags[i + 1]!;
      if (flag === "--limit" && !/^\d{1,3}$/u.test(value)) return undefined;
      if (flag === "--before" && !/^\d{12}$/u.test(value)) return undefined;
      query.set(flag.slice(2), value);
      i += 1;
    } else return undefined;
  }
  const encoded = query.toString();
  return encoded.length === 0 ? "" : `?${encoded}`;
}

/** Follow is read for each delivery and queued turn; changing it needs no restart. */
export async function runLinearCommand(
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly settings?: SettingsStore } = {},
) {
  const ack = args.length === 3 && args[0] === "inbox" && args[1] === "ack" && /^\d{12}$/u.test(args[2]!);
  const read =
    args[0] === "inbox" && (args.length === 1 || args[1] === "read")
      ? parseInboxRead(args.slice(2))
      : undefined;
  if (read !== undefined || ack) {
    const env = options.env ?? process.env;
    const credential = await resolveOperatorCredential({ env });
    if (credential === undefined)
      throw new Error("Linear inbox needs the local operator credential. Run clankie doctor.");
    const response = await fetch(`${commandHost({ env })}/v1/linear/inbox${read ?? ""}`, {
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
    throw new Error(LINEAR_USAGE);
  }
  return {
    ok: true as const,
    following: current.linearWebhook.following,
    conversationId: "linear-inbox",
    settingsFile: settings.path,
  };
}
