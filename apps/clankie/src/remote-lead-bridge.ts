import { AsyncLocalStorage } from "node:async_hooks";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { SeatTranscriptUploadSchema } from "@clankie/agent-transcript";
import { occupantIdForHerdrSession } from "./captain/herdr-census.ts";
import { OperatorSeatCapabilitiesSchema, OperatorSeatReplySchema } from "@clankie/protocol";
import type { CaptainPort, LaneToolBank } from "./captain/port.ts";
import { createLaneMcpEndpoint } from "./lane-mcp.ts";
import type { LocalFleetIdentity } from "./local-fleet-link.ts";
import type { RemoteLeadDelegations } from "./remote-lead-delegations.ts";

// Delegates project leadership and messaging, with conversation-attributed effects.
// Owner configuration, accounts and unrelated conversations are not delegated.
const PROJECT_TOOLS = new Set([
  "hire_agent",
  "settle_hire_receipt",
  "message_seat",
  "worker_reports",
  "acknowledge_worker_reports",
  "herdr_watch",
  "schedule_wake",
  "report_continuation",
  "cancel_wake",
  "routine",
  "request_user_input",
  "mail_owner_update",
  "refresh_worker_tools",
  "close_worker_pane",
  "mcp_tool_search",
  "mcp_tool_call",
]);
export interface RemoteSeatAuthority {
  readonly id: string;
  readonly binding: { readonly conversationId: string; readonly nativeOccupantId: string };
  readonly signal: AbortSignal;
  readonly worker?: boolean;
  toolBank?(bank: LaneToolBank): Promise<LaneToolBank>;
  pollEvents?(
    wait: number,
    signal: AbortSignal,
  ): Promise<readonly import("@clankie/protocol").OperatorSeatEvent[]>;
  acknowledge?(eventId: string): Promise<boolean>;
  current(): boolean;
  authorize(): Promise<boolean>;
}
type Authority = RemoteSeatAuthority;

export function createRemoteLeadBridge(input: {
  captain: CaptainPort;
  delegations: Pick<RemoteLeadDelegations, "isRevoked" | "close"> & {
    authorize(request: Request, identity: LocalFleetIdentity | undefined): Promise<Authority | undefined>;
  };
  identity(request: Request): LocalFleetIdentity | undefined;
  receiptPath?: string;
}) {
  const calls = new AsyncLocalStorage<Authority>();
  const endpoints = new Map<string, ReturnType<typeof createLaneMcpEndpoint>>();
  const app = new Hono();
  app.use("/v1/fleet/lead/*", bodyLimit({ maxSize: 1024 * 1024 }));
  const requireCurrent = async (authority: Authority) => {
    if (!authority.current() || !(await authority.authorize())) throw new Error("remote_lead_revoked");
  };
  app.all("/v1/fleet/lead/*", async (context) => {
    if (input.delegations.isRevoked(context.req.raw))
      return context.json({ error: "remote_lead_revoked" }, 403);
    const path = new URL(context.req.url).pathname;
    const transcriptRequest = path === "/v1/fleet/lead/transcript" && context.req.method === "POST";
    // Consume the body before the fresh proof, then commit synchronously. There
    // is no asynchronous work between admission and the display-only store write.
    const parsed = transcriptRequest
      ? SeatTranscriptUploadSchema.safeParse(await context.req.json())
      : undefined;
    const authenticationStarted = performance.now();
    let authority: Authority | undefined;
    try {
      authority = await input.delegations.authorize(context.req.raw, input.identity(context.req.raw));
    } catch {
      return context.json({ error: "remote_lead_authority_unavailable" }, 403);
    }
    if (!authority) return context.json({ error: "remote_lead_authority_required" }, 403);
    const admitted = authority;
    const conversationId = admitted.binding.conversationId;
    const claimed = context.req.query("conversationId");
    if (claimed !== undefined && claimed !== conversationId)
      return context.json({ error: "remote_lead_conversation_mismatch" }, 403);
    if (transcriptRequest) {
      if (admitted.worker) return context.json({ error: "worker_transcript_refused" }, 403);
      if (
        !parsed?.success ||
        occupantIdForHerdrSession({ source: "herdr:claude", kind: "id", value: parsed.data.sessionId }) !==
          admitted.binding.nativeOccupantId
      )
        return context.json({ error: "remote_lead_session_mismatch" }, 403);
      if (!admitted.current()) return context.json({ error: "remote_lead_revoked" }, 403);
      const authenticationMs = performance.now() - authenticationStarted;
      const storeStarted = performance.now();
      const synced = input.captain.syncSeatTranscript(conversationId, parsed.data);
      context.header(
        "server-timing",
        `auth;dur=${authenticationMs.toFixed(1)}, store;dur=${(performance.now() - storeStarted).toFixed(1)}`,
      );
      return context.json({ ok: synced }, synced ? 200 : 409);
    }
    return calls.run(admitted, async () => {
      await requireCurrent(admitted);
      if (path === "/v1/fleet/lead/mcp") {
        let endpoint = endpoints.get(admitted.id);
        if (!endpoint) {
          const delegation = {
            owner: { conversationId },
            current: () => calls.getStore()?.id === admitted.id && calls.getStore()!.current(),
            authorize: async () => {
              const current = calls.getStore();
              return current?.id === admitted.id && (await current.authorize());
            },
          };
          endpoint = createLaneMcpEndpoint({
            ...(input.receiptPath === undefined ? {} : { receiptPath: input.receiptPath }),
            captain: {
              laneToolBank: async () => {
                const original = admitted.worker
                  ? { lane: "operator" as const, tools: [] }
                  : await input.captain.laneToolBank("operator", conversationId, delegation);
                const bank = admitted.toolBank ? await admitted.toolBank(original) : original;
                return {
                  ...bank,
                  tools: bank.tools
                    // The delegated captain bank narrows both direct and deferred
                    // connected tools to the tracker; never expose its general directory.
                    .filter(
                      (tool) =>
                        admitted.worker || PROJECT_TOOLS.has(tool.name) || tool.name.startsWith("linear_"),
                    )
                    .map((tool) => ({
                      ...tool,
                      ...(tool.name === "linear_wake"
                        ? {
                            description:
                              "Confirm a Linear wake received in this lead chat, using its original wakeId. Wake settings and routing remain owner-controlled.",
                            inputSchema: {
                              type: "object",
                              properties: {
                                action: { type: "string", const: "received" },
                                wakeId: { type: "string", pattern: "^seat-[a-f0-9-]{36}$" },
                              },
                              required: ["action", "wakeId"],
                              additionalProperties: false,
                            },
                          }
                        : {}),
                      call: async (args, options) => {
                        const current = calls.getStore();
                        if (!current || current.id !== admitted.id) throw new Error("remote_lead_revoked");
                        await requireCurrent(current);
                        if (
                          tool.name === "linear_wake" &&
                          (args.action !== "received" ||
                            Object.keys(args).some((key) => key !== "action" && key !== "wakeId"))
                        )
                          throw new Error("remote_lead_wake_settings_denied");
                        return tool.call(args, options);
                      },
                    })),
                };
              },
              reconcileSeatDelivery: (id) =>
                input.captain.reconcileSeatDelivery?.(id, conversationId) ?? Promise.resolve(undefined),
            },
          });
          endpoints.set(admitted.id, endpoint);
          const created = endpoint;
          admitted.signal.addEventListener(
            "abort",
            () => {
              endpoints.delete(admitted.id);
              void created.close();
            },
            { once: true },
          );
        }
        return endpoint.handle(context.req.raw, "operator", conversationId);
      }
      if (path === "/v1/fleet/lead/prompt" && context.req.method === "GET") {
        const prompt = await input.captain.lanePrompt({
          lane: "operator",
          conversationId,
          harness: "claude",
          sections: ["persona", "reach", "address", "model", "conversation"],
        });
        await requireCurrent(admitted);
        return context.text(prompt);
      }
      if (path === "/v1/fleet/lead/memory-card" && context.req.method === "GET") {
        const card = await input.captain.laneMemoryCard("operator");
        await requireCurrent(admitted);
        return context.text(card);
      }
      if (path === "/v1/fleet/lead/events" && context.req.method === "GET") {
        const raw = context.req.header("x-clankie-seat-capabilities");
        const capabilities = OperatorSeatCapabilitiesSchema.safeParse(raw ? JSON.parse(raw) : undefined);
        if (!capabilities.success) return context.json({ error: "invalid_seat_capabilities" }, 400);
        const wait = Number(context.req.query("wait") ?? 25_000);
        const events = admitted.pollEvents
          ? await admitted.pollEvents(
              Number.isFinite(wait) ? Math.min(25_000, Math.max(0, Math.trunc(wait))) : 25_000,
              AbortSignal.any([context.req.raw.signal, admitted.signal]),
            )
          : await input.captain.pollSeatEvents(
              Number.isFinite(wait) ? Math.min(25_000, Math.max(0, Math.trunc(wait))) : 25_000,
              AbortSignal.any([context.req.raw.signal, admitted.signal]),
              conversationId,
              capabilities.data,
              { owner: { conversationId }, current: admitted.current, authorize: admitted.authorize },
            );
        await requireCurrent(admitted);
        return context.json({ schemaVersion: 1, events });
      }
      const event = /^\/v1\/fleet\/lead\/events\/([^/]+)\/(ack|reply)$/u.exec(path);
      if (event && context.req.method === "POST") {
        const reply =
          event[2] === "reply" ? OperatorSeatReplySchema.safeParse(await context.req.json()) : undefined;
        if (reply && !reply.success) return context.json({ error: "invalid_request" }, 400);
        await requireCurrent(admitted);
        if (admitted.worker && reply?.success) return context.json({ error: "worker_reply_refused" }, 403);
        const ok = admitted.acknowledge
          ? await admitted.acknowledge(event[1]!)
          : reply?.success
            ? await input.captain.replySeatEvent(event[1]!, reply.data.text, conversationId)
            : await input.captain.acknowledgeSeatEvent(event[1]!, conversationId);
        return context.json({ ok }, ok ? 200 : 404);
      }
      return context.json({ error: "not_found" }, 404);
    });
  });
  return {
    app,
    close: async () => {
      input.delegations.close();
      await Promise.all([...endpoints.values()].map((endpoint) => endpoint.close()));
      endpoints.clear();
    },
  };
}
