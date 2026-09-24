import { resolveOperatorCredential } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import { SettingsStore, defaultSettingsPath } from "@clankie/settings";

const LINEAR_USAGE =
  "Usage: clankie linear [status] | follow on|off | inbox [read [--limit N] [--before CURSOR] [--headlines] | ack CURSOR [--conversation ID]] | work [list | bind ORG ISSUE CONVERSATION [--from ID] | unbind ORG ISSUE CONVERSATION]";

/** The query string for `inbox read` flags; `undefined` when a flag is malformed. */
export function parseInboxRead(flags: readonly string[]): string | undefined {
  const query = new URLSearchParams();
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    if (flag === "--headlines") query.set("headlines", "1");
    else if (
      (flag === "--limit" || flag === "--before" || flag === "--conversation") &&
      flags[i + 1] !== undefined
    ) {
      const value = flags[i + 1]!;
      if (flag === "--limit" && !/^\d{1,3}$/u.test(value)) return undefined;
      if (flag === "--before" && !/^\d{12}$/u.test(value)) return undefined;
      if (flag === "--conversation" && !/^[a-zA-Z0-9_-]{1,256}$/u.test(value)) return undefined;
      query.set(flag === "--conversation" ? "conversationId" : flag.slice(2), value);
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
  const request = async (path: string, method = "GET", body?: unknown) => {
    const env = options.env ?? process.env;
    const credential = await resolveOperatorCredential({ env });
    if (!credential) throw new Error("Linear work needs the operator credential. Run clankie doctor.");
    const response = await fetch(`${commandHost({ env })}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Linear request failed: ${response.status}`);
    return response.json();
  };
  if (args[0] === "work") {
    if (args.length === 1 || (args.length === 2 && args[1] === "list")) return request("/v1/linear/work");
    if (
      (args[1] === "bind" && (args.length === 5 || (args.length === 7 && args[5] === "--from"))) ||
      (args[1] === "unbind" && args.length === 5)
    )
      return request("/v1/linear/work", args[1] === "unbind" ? "DELETE" : "PUT", {
        organizationId: args[2],
        issueId: args[3],
        conversationId: args[4],
        ...(args[6] ? { expectedConversationId: args[6] } : {}),
      });
    throw new Error(LINEAR_USAGE);
  }
  const ack =
    args[0] === "inbox" &&
    args[1] === "ack" &&
    /^\d{12}$/u.test(args[2] ?? "") &&
    (args.length === 3 ||
      (args.length === 5 && args[3] === "--conversation" && /^[a-zA-Z0-9_-]{1,256}$/u.test(args[4]!)));
  const read =
    args[0] === "inbox" && (args.length === 1 || args[1] === "read")
      ? parseInboxRead(args.slice(2))
      : undefined;
  if (read !== undefined || ack) {
    return request(
      `/v1/linear/inbox${read ?? ""}`,
      ack ? "POST" : "GET",
      ack
        ? {
            ackCursor: args[2],
            ...(args[4] ? { conversationId: args[4] } : {}),
          }
        : undefined,
    );
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
