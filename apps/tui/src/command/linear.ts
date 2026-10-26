import { decodeMcpResult } from "@clankie/protocol/mcp-result";
import type { CaptainRouteFetcher } from "../session/operator-conversations.ts";
import { ownerSettingsApi } from "./owner-settings-api.ts";
import {
  LINEAR_WAKE_PATH,
  LINEAR_FOLLOW_PATH,
  LinearWakeSnapshotSchema,
  LinearFollowSnapshotSchema,
} from "@clankie/protocol/linear-settings";
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
  LINEAR_REQUEST_BUDGET_PATH,
  LinearRequestBudgetReportSchema,
} from "@clankie/protocol/linear-request-budget";
import {
  SettingsStore,
  defaultSettingsPath,
  linearFollowStatus,
  LinearWebhookSettingsSchema,
  LinearWakeSettingsSchema,
} from "@clankie/settings";

const LINEAR_USAGE =
  "Usage: clankie linear [status] | budget | deliveries | routes [show|set --json-stdin] | read TOOL --json-stdin [--background] | graphql --json-stdin | post comment|issue --json-stdin | follow on|off | target [show|set CONVERSATION_ID] | wake [show|set --actors owner,human,self,users --owner-user-ids IDS --owner-user-emails EMAILS --user-ids IDS --types TYPES --exclude-types TYPES | set --json-stdin] | webhook set --url URL | webhook clear";

function publishingResult(result: Awaited<ReturnType<LaneToolUpstream["callTool"]>>) {
  // Lane tools wrap the host result as JSON text. A refused host call is not
  // necessarily a protocol-level MCP error, so inspect both boundaries.
  try {
    const host = z
      .object({ outcome: z.literal("ok"), isError: z.boolean().optional() })
      .safeParse(decodeMcpResult(result));
    return { ...result, ok: result.isError !== true && host.success && host.data.isError !== true };
  } catch {
    return { ...result, ok: false };
  }
}

function laneCredentialRefusal(detail: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          outcome: "refused",
          reason: "lane_credential_unavailable",
          lane: "operator",
          possiblyDispatched: false,
          detail,
        }),
      },
    ],
    isError: true,
    ok: false,
  };
}

/** Follow is read for each delivery and queued turn; changing it needs no restart. */
export async function runLinearCommand(
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly settings?: SettingsStore;
    readonly host?: string;
    readonly fetchImpl?: typeof fetch;
    readonly ownerFetcher?: CaptainRouteFetcher | undefined;
    readonly operatorCredentialStore?: CredentialStore;
    readonly expectedRevision?: string;
    readonly credentials?: Pick<CredentialStore, "get">;
    readonly stdin?: Parameters<typeof text>[0];
    readonly callTool?: LaneToolUpstream["callTool"];
  } = {},
) {
  if (args[0] === "read") {
    if (
      (args.length !== 3 && args.length !== 4) ||
      args[2] !== "--json-stdin" ||
      (args.length === 4 && args[3] !== "--background") ||
      !/^(?:get|list|search|check|fetch|read)_[a-z_]+$/u.test(args[1] ?? "")
    )
      throw new Error(LINEAR_USAGE);
    const body: unknown = JSON.parse(await text(options.stdin ?? process.stdin));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object");
    const name = `linear_${args[1]}`;
    const purpose = args[3] === "--background" ? { background: true } : undefined;
    if (options.callTool)
      return publishingResult(await options.callTool("mcp_tool_call", { name, arguments: body }, purpose));
    const env = options.env ?? process.env;
    let credential;
    try {
      credential = await resolveOperatorCredential({
        env,
        ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
      });
    } catch (error) {
      return laneCredentialRefusal(error instanceof Error ? error.message : String(error));
    }
    if (!credential)
      return laneCredentialRefusal(
        "The CLI operator lane has no credential. Use the admitted connected bridge; do not borrow another lane's bearer.",
      );
    const upstream = await connectLaneUpstream({
      host: commandHost({ env, ...(options.host === undefined ? {} : { host: options.host }) }),
      bearer: credential.token,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    try {
      return publishingResult(await upstream.callTool("mcp_tool_call", { name, arguments: body }, purpose));
    } finally {
      await upstream.close();
    }
  }
  if (args[0] === "graphql") {
    if (args.length !== 2 || args[1] !== "--json-stdin") throw new Error(LINEAR_USAGE);
    const body: unknown = JSON.parse(await text(options.stdin ?? process.stdin));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object");
    if (options.callTool)
      return publishingResult(
        await options.callTool("mcp_tool_call", { name: "linear_graphql", arguments: body }),
      );
    const env = options.env ?? process.env;
    let credential;
    try {
      credential = await resolveOperatorCredential({
        env,
        ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
      });
    } catch (error) {
      return laneCredentialRefusal(error instanceof Error ? error.message : String(error));
    }
    if (!credential)
      return laneCredentialRefusal(
        "The CLI operator lane has no credential. Use the admitted connected bridge; do not borrow another lane's bearer.",
      );
    const upstream = await connectLaneUpstream({
      host: commandHost({ env, ...(options.host === undefined ? {} : { host: options.host }) }),
      bearer: credential.token,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    try {
      return publishingResult(
        await upstream.callTool("mcp_tool_call", { name: "linear_graphql", arguments: body }),
      );
    } finally {
      await upstream.close();
    }
  }
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
  const settings = options.settings ?? new SettingsStore(defaultSettingsPath(options.env ?? process.env));
  if (args[0] === "deliveries") {
    if (args.length !== 1) throw new Error(LINEAR_USAGE);
    return request("/v1/linear/deliveries");
  }
  if (args[0] === "routes") {
    if (args.length === 1 || (args.length === 2 && args[1] === "show"))
      return { ok: true, projectChats: (await settings.load()).linearWebhook.projectChats };
    if (args.length !== 3 || args[1] !== "set" || args[2] !== "--json-stdin") throw new Error(LINEAR_USAGE);
    const projectChats = LinearWebhookSettingsSchema.shape.projectChats.parse(
      JSON.parse(await text(options.stdin ?? process.stdin)),
    );
    return request("/v1/linear/routes", "PUT", { projectChats });
  }
  if (args[0] === "budget") {
    if (args.length !== 1) throw new Error(LINEAR_USAGE);
    return LinearRequestBudgetReportSchema.parse(await request(LINEAR_REQUEST_BUDGET_PATH));
  }
  if (args[0] === "target") {
    if (args.length === 1 || (args.length === 2 && args[1] === "show"))
      return { ok: true, wakeConversationId: (await settings.load()).linearWebhook.wakeConversationId };
    if (args.length !== 3 || args[1] !== "set" || !/^[a-zA-Z0-9_-]{1,256}$/u.test(args[2]!))
      throw new Error(LINEAR_USAGE);
    return request("/v1/linear/target", "PUT", { conversationId: args[2] });
  }
  if (args[0] === "wake") {
    const api = await ownerSettingsApi(options);
    const snapshot = await api.get(LINEAR_WAKE_PATH, LinearWakeSnapshotSchema);
    if (args.length === 1 || (args.length === 2 && args[1] === "show")) return { ok: true, ...snapshot };
    if (args[1] !== "set" || args.length < 3) throw new Error(LINEAR_USAGE);
    let wake;
    if (args.length === 3 && args[2] === "--json-stdin")
      wake = LinearWakeSettingsSchema.parse(JSON.parse(await text(options.stdin ?? process.stdin)));
    else {
      const fields: Record<string, string> = {
        "--actors": "actors",
        "--owner-user-ids": "ownerUserIds",
        "--owner-user-emails": "ownerUserEmails",
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
      wake = LinearWakeSettingsSchema.parse({ ...snapshot.wake, ...patch });
    }
    return {
      ok: true,
      ...(await api.write(
        LINEAR_WAKE_PATH,
        { expectedRevision: options.expectedRevision ?? snapshot.revision, wake },
        LinearWakeSnapshotSchema,
      )),
    };
  }
  if (args.length === 0 || (args.length === 1 && args[0] === "status") || args[0] === "follow") {
    if (args[0] === "follow" && (args.length !== 2 || !["on", "off"].includes(args[1]!)))
      throw new Error(LINEAR_USAGE);
    if (args[0] === "status" && args.length !== 1) throw new Error(LINEAR_USAGE);
    const api = await ownerSettingsApi(options);
    const snapshot = await api.get(LINEAR_FOLLOW_PATH, LinearFollowSnapshotSchema);
    if (args[0] !== "follow") return { ok: true, ...snapshot };
    if (args[1] === "on" && snapshot.reason === "linear_webhook_required")
      return { ok: false, error: snapshot.reason, ...snapshot };
    if (args.length !== 2 || !["on", "off"].includes(args[1]!)) throw new Error(LINEAR_USAGE);
    return {
      ok: true,
      ...(await api.write(
        LINEAR_FOLLOW_PATH,
        { expectedRevision: options.expectedRevision ?? snapshot.revision, following: args[1] === "on" },
        LinearFollowSnapshotSchema,
      )),
    };
  }
  if (args.length > 0 && !["status", "follow", "webhook"].includes(args[0]!)) throw new Error(LINEAR_USAGE);
  const credentials =
    options.credentials ?? createDefaultCredentialStore({ env: options.env ?? process.env });
  const secret = await credentials.get(LINEAR_WEBHOOK_PROVIDER_ID);
  const secretPresent = secret?.type === "api" && secret.key.trim().length > 0;
  let current;
  if (args[0] === "webhook" && args[1] === "set" && args[2] === "--url" && args.length === 4) {
    const { url } = LinearWebhookSettingsSchema.parse({ url: args[3] });
    current = await settings.update((value) => ({
      ...value,
      linearWebhook: { ...value.linearWebhook, url },
    }));
  } else if (args[0] === "webhook" && args[1] === "clear" && args.length === 2) {
    current = await settings.update((value) => ({
      ...value,
      linearWebhook: {
        following: value.linearWebhook.following,
        wakeConversationId: value.linearWebhook.wakeConversationId,
        wake: value.linearWebhook.wake,
        projectChats: value.linearWebhook.projectChats,
      },
    }));
  } else {
    throw new Error(LINEAR_USAGE);
  }
  return {
    ok: true,
    ...linearFollowStatus(current.linearWebhook, secretPresent),
    wakeConversationId: current.linearWebhook.wakeConversationId,
    settingsFile: settings.path,
  };
}

/** Read the same lane catalog the CLI dispatches through, without executing a query. */
export async function inspectLinearGraphqlLane(options: {
  env: NodeJS.ProcessEnv;
  credentials: CredentialStore;
  fetchImpl?: typeof fetch;
}): Promise<
  | { usable: true; scope: "operator_connected_catalog" }
  | {
      usable: false;
      reason: "lane_credential_unavailable" | "lane_catalog_unavailable" | "lane_tool_unavailable";
      detail: string;
    }
> {
  let upstream: LaneToolUpstream | undefined;
  try {
    try {
      const credential = await resolveOperatorCredential({ env: options.env, store: options.credentials });
      if (!credential)
        return {
          usable: false,
          reason: "lane_credential_unavailable",
          detail: "No credential for the CLI operator lane; use the admitted connected bridge.",
        };
      upstream = await connectLaneUpstream({
        host: commandHost({ env: options.env }),
        bearer: credential.token,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      });
      const result = await upstream.callTool("mcp_tool_search", { names: ["linear_graphql"] });
      const catalog = z
        .object({ tools: z.array(z.object({ name: z.string() })) })
        .safeParse(decodeMcpResult(result));
      if (result.isError || !catalog.success)
        return {
          usable: false,
          reason: "lane_catalog_unavailable",
          detail: "The CLI operator lane did not return a connected catalog.",
        };
      if (!catalog.data.tools.some((tool) => tool.name === "linear_graphql"))
        return {
          usable: false,
          reason: "lane_tool_unavailable",
          detail:
            "linear_graphql is absent from this CLI operator lane's connected catalog; lane grants, server readiness or credential audience may restrict it. Use mcp_tool_search in the admitted connected bridge for its own scope.",
        };
      return { usable: true, scope: "operator_connected_catalog" };
    } finally {
      await upstream?.close();
    }
  } catch (error) {
    return {
      usable: false,
      reason: "lane_catalog_unavailable",
      detail: `CLI operator lane catalog unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
