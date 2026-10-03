import {
  createDefaultCredentialStore,
  LINEAR_WEBHOOK_PROVIDER_ID,
  resolveOperatorCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import { text } from "node:stream/consumers";
import { connectLaneUpstream, type LaneToolUpstream } from "./mcp.ts";
import { z } from "zod";
import {
  SettingsStore,
  defaultSettingsPath,
  linearFollowStatus,
  LinearWebhookSettingsSchema,
  LinearWakeSettingsSchema,
} from "@clankie/settings";

const LINEAR_USAGE =
  "Usage: clankie linear [status] | post comment|issue --json-stdin | follow on|off | wake [show|set --actors owner,human,self,users --owner-user-ids IDS --user-ids IDS --types TYPES --exclude-types TYPES | set --json-stdin] | webhook set --url URL | webhook clear | inbox [read [--limit N] [--before CURSOR] [--headlines] | ack CURSOR [--conversation ID]] | work [list]";

function publishingResult(result: Awaited<ReturnType<LaneToolUpstream["callTool"]>>) {
  // Lane tools wrap the host result as JSON text. A refused host call is not
  // necessarily a protocol-level MCP error, so inspect both boundaries.
  const content = result.content.find((block) => block.type === "text");
  try {
    const host = z
      .object({ outcome: z.literal("ok"), isError: z.boolean().optional() })
      .safeParse(JSON.parse(content?.type === "text" ? content.text : "null"));
    return { ...result, ok: result.isError !== true && host.success && host.data.isError !== true };
  } catch {
    return { ...result, ok: false };
  }
}

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
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly settings?: SettingsStore;
    readonly credentials?: Pick<CredentialStore, "get">;
    readonly stdin?: Parameters<typeof text>[0];
    readonly callTool?: LaneToolUpstream["callTool"];
  } = {},
) {
  if (args[0] === "post") {
    if (args.length !== 3 || !["comment", "issue"].includes(args[1]!) || args[2] !== "--json-stdin")
      throw new Error(LINEAR_USAGE);
    const body: unknown = JSON.parse(await text(options.stdin ?? process.stdin));
    if (typeof body !== "object" || body === null || Array.isArray(body))
      throw new Error("Expected a JSON object");
    const name = `linear_create_worker_${args[1]}`;
    if (options.callTool) {
      const result = await options.callTool(name, body as Record<string, unknown>);
      return publishingResult(result);
    }
    const env = options.env ?? process.env;
    const credential = await resolveOperatorCredential({ env });
    if (!credential) throw new Error("Worker publishing needs the operator credential. Run clankie doctor.");
    const upstream = await connectLaneUpstream({ host: commandHost({ env }), bearer: credential.token });
    try {
      const result = await upstream.callTool(name, body as Record<string, unknown>);
      return publishingResult(result);
    } finally {
      await upstream.close();
    }
  }
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
    if (args[1] === "bind" || args[1] === "unbind")
      throw new Error("Linear issue bindings are retired. Use clankie linear work list to read old records.");
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
  if (args[0] === "wake") {
    if (args.length === 1 || (args.length === 2 && args[1] === "show"))
      return { ok: true, wake: (await settings.load()).linearWebhook.wake, settingsFile: settings.path };
    if (args[1] !== "set" || args.length < 3) throw new Error(LINEAR_USAGE);
    let current;
    if (args.length === 3 && args[2] === "--json-stdin") {
      const wake = LinearWakeSettingsSchema.parse(JSON.parse(await text(options.stdin ?? process.stdin)));
      current = await settings.update((value) => ({
        ...value,
        linearWebhook: { ...value.linearWebhook, wake },
      }));
    } else {
      const fields: Record<string, string> = {
        "--actors": "actors",
        "--owner-user-ids": "ownerUserIds",
        "--user-ids": "userIds",
        "--types": "notificationTypes",
        "--exclude-types": "excludedNotificationTypes",
      };
      const patch: Record<string, string[]> = {};
      for (let i = 2; i < args.length; i += 2) {
        const field = fields[args[i]!];
        const value = args[i + 1];
        if (!field || value === undefined || value.startsWith("--") || Object.hasOwn(patch, field))
          throw new Error(LINEAR_USAGE);
        patch[field] = value === "none" ? [] : value.split(",").map((item) => item.trim());
      }
      current = await settings.update((value) => ({
        ...value,
        linearWebhook: {
          ...value.linearWebhook,
          wake: LinearWakeSettingsSchema.parse({ ...value.linearWebhook.wake, ...patch }),
        },
      }));
    }
    return { ok: true, wake: current.linearWebhook.wake, settingsFile: settings.path };
  }
  const credentials =
    options.credentials ?? createDefaultCredentialStore({ env: options.env ?? process.env });
  const secret = await credentials.get(LINEAR_WEBHOOK_PROVIDER_ID);
  const secretPresent = secret?.type === "api" && secret.key.trim().length > 0;
  let current;
  let refused = false;
  if (args.length === 0 || (args.length === 1 && args[0] === "status")) {
    current = await settings.load();
  } else if (args.length === 2 && args[0] === "follow" && (args[1] === "on" || args[1] === "off")) {
    current = await settings.update((value) => {
      if (args[1] === "on" && !linearFollowStatus(value.linearWebhook, secretPresent).webhookConfigured) {
        refused = true;
        return value;
      }
      return { ...value, linearWebhook: { ...value.linearWebhook, following: args[1] === "on" } };
    });
  } else if (args[0] === "webhook" && args[1] === "set" && args[2] === "--url" && args.length === 4) {
    const { url } = LinearWebhookSettingsSchema.parse({ url: args[3] });
    current = await settings.update((value) => ({
      ...value,
      linearWebhook: { ...value.linearWebhook, url },
    }));
  } else if (args[0] === "webhook" && args[1] === "clear" && args.length === 2) {
    current = await settings.update((value) => ({
      ...value,
      linearWebhook: { following: value.linearWebhook.following, wake: value.linearWebhook.wake },
    }));
  } else {
    throw new Error(LINEAR_USAGE);
  }
  return {
    ok: !refused,
    ...(refused ? { error: "linear_webhook_required" as const } : {}),
    ...linearFollowStatus(current.linearWebhook, secretPresent),
    conversationId: "linear-inbox",
    wakeConversationId: "global-default",
    settingsFile: settings.path,
  };
}
