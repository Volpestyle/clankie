/**
 * Clankie's own tools, served over streamable-HTTP MCP (VUH-1085).
 *
 * The bearer picks the lane, and the lane picks the tools: a connection sees
 * exactly that lane's authority plan, assembled by the captain's one registry.
 * MCP here is transport only — it grants nothing a pi session in the same lane
 * would not already hold.
 */
import { randomUUID } from "node:crypto";
import { withLinearRequestPriority } from "./linear-request-budget.ts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  RECONCILE_SEAT_CALL,
  OWNER_UPDATE_PUBLICATION_META,
  OwnerUpdatePublicationSchema,
  SEAT_CALL_META,
  SeatCallIdSchema,
  SeatCallRequestSchema,
  SeatCallToolSchema,
  uncertainSeatCall,
  type CaptainSessionLaneV2,
} from "@clankie/protocol";
import { laneToolHints, listedOnLane } from "./captain/mcp-tool-surface.ts";
import type { CaptainPort, LaneTool, LaneToolResult } from "./captain/port.ts";
import { assertMcpToolsList } from "./mcp-tool-schema.ts";
import { SeatCallReceipts } from "./seat-call-receipts.ts";
import { CLANKIE_VERSION } from "./app/log.ts";

/** How long an untouched session survives. Swept lazily, on the next request. */
const SESSION_IDLE_MS = 60 * 60_000;

interface LaneMcpSession {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly server: Server;
  readonly lane: CaptainSessionLaneV2;
  readonly conversationId?: string;
  readonly responses: Set<Promise<Response>>;
  lastSeenAt: number;
}

export interface LaneMcpEndpoint {
  handle(request: Request, lane: CaptainSessionLaneV2, conversationId?: string): Promise<Response>;
  close(): Promise<void>;
}

function instructionsFor(lane: CaptainSessionLaneV2, unboundOperator: boolean): string {
  if (unboundOperator)
    return "This operator-bearer session has no conversation. Stateless tools are available; conversation-scoped lead tools require a verified launcher binding. It never inherits global-default.";
  return [
    `These are Clankie's own tools, in his ${lane} lane. He is a persistent agent with a`,
    "life outside this connection — memory, rooms, a browser, connected services — and calling",
    "one of these acts as him, in that lane, not as a private utility for this session.",
    "The list is that lane's whole authority: nothing else is reachable from here.",
  ].join(" ");
}

/**
 * A bearer resolves to a lane on every request, so a session opened by one
 * bearer can never be driven by another. Sessions are in-memory; protected
 * dispatch receipts survive a restart independently of the MCP session.
 */
export function createLaneMcpEndpoint({
  captain,
  receiptPath,
}: {
  captain: Pick<
    CaptainPort,
    "laneToolBank" | "reconcileSeatDelivery" | "settleSeatDelivery" | "operatorSeatMigrationHeld"
  >;
  receiptPath?: string;
}): LaneMcpEndpoint {
  const sessions = new Map<string, LaneMcpSession>();
  const receipts = new SeatCallReceipts(receiptPath);
  const shutdown = new AbortController();
  const failure = (error: unknown) => ({
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  });
  const reconciliationTool = {
    name: RECONCILE_SEAT_CALL,
    description:
      "Read the original operator message_seat or hire_agent receipt by its MCP deliveryId, native channel event ID, or hireId. " +
      "Never dispatches, retries, or starts an agent. Use the same conversation as the original call. " +
      "A seat-call ID your bridge minted that the service never received is closed as not dispatched, so the original " +
      "cannot run late and the action may be sent again as a new call; any other unknown ID is left open. " +
      'With settle: "not_delivered" and a deliveryId, settle an unresolved original that blocks a seat: proven arrival is recorded delivered, ' +
      "otherwise it is recorded not delivered and kept as abandoned-unknown. Nothing is sent, and the original is never resent.",
    inputSchema: {
      type: "object" as const,
      properties: {
        deliveryId: { type: "string", minLength: 1, maxLength: 256 },
        hireId: { type: "string", format: "uuid" },
        settle: { type: "string", enum: ["not_delivered"] },
      },
      oneOf: [{ required: ["deliveryId"] }, { required: ["hireId"] }],
      additionalProperties: false,
    },
  };

  const dispose = async (id: string, session: LaneMcpSession): Promise<void> => {
    sessions.delete(id);
    try {
      await session.server.close();
    } catch {
      // A session already torn down by its transport has nothing left to close.
    }
  };

  // ponytail: idle sweep runs on request, and "idle" counts requests only — a
  // client holding a notification stream open for an hour without asking
  // anything is dropped and reconnects. A timer plus stream liveness is the
  // upgrade if that reconnect is ever more than a hiccup.
  const sweep = (): void => {
    const deadline = Date.now() - SESSION_IDLE_MS;
    for (const [id, session] of sessions) {
      if (session.lastSeenAt < deadline) void dispose(id, session);
    }
  };

  const open = async (lane: CaptainSessionLaneV2, conversationId?: string): Promise<LaneMcpSession> => {
    const unboundOperator = lane === "operator" && conversationId === undefined;
    const bank = unboundOperator
      ? await captain.laneToolBank(lane, undefined, undefined, { conversation: "none" })
      : await captain.laneToolBank(lane, conversationId);
    const byName = new Map<string, LaneTool>(bank.tools.map((tool) => [tool.name, tool]));
    // Unlisted tools stay reachable through the bank's own search and call pair.
    const unlisted =
      byName.has("mcp_tool_search") && byName.has("mcp_tool_call")
        ? bank.tools.filter((tool) => !listedOnLane(lane, tool.name))
        : [];
    const server = new Server(
      { name: "clankie", version: CLANKIE_VERSION },
      { capabilities: { tools: {} }, instructions: instructionsFor(lane, unboundOperator) },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => {
      const result = {
        tools: [
          ...bank.tools
            .filter((tool) => !unlisted.includes(tool))
            .map((tool) => ({
              name: tool.name,
              description:
                tool.name === "mcp_tool_search" && unlisted.length > 0
                  ? `${tool.description} It also finds his own play and media tools (Minecraft, PokeAgent, music, images, video, diagrams), which this list leaves out.`
                  : tool.description,
              // TypeBox's union of objects omits its root type. Only those
              // unions are adapted; an invalid authored root must stay visible.
              inputSchema: objectUnionRoot(tool.inputSchema),
              ...laneToolHints(lane, tool.name),
            })),
          ...(lane === "operator" ? [reconciliationTool] : []),
        ],
      };
      assertMcpToolsList(result, `${lane} lane`);
      return result;
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      // Receipt operations and protected native dispatches name an original
      // conversation. Never let their optional IDs select the lead by default.
      if (
        unboundOperator &&
        (request.params.name === RECONCILE_SEAT_CALL ||
          SeatCallToolSchema.safeParse(request.params.name).success)
      )
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "conversation_binding_required",
                recovery:
                  "Use a verified launcher-bound conversation for lead tools. Stateless tools remain available on the operator bearer.",
              }),
            },
          ],
          isError: true,
        };
      if (request.params.name === RECONCILE_SEAT_CALL && lane === "operator") {
        const args = request.params.arguments ?? {};
        if (args.settle !== undefined) {
          if (
            args.settle !== "not_delivered" ||
            Object.keys(args).some((name) => name !== "deliveryId" && name !== "settle") ||
            typeof args.deliveryId !== "string" ||
            args.deliveryId.length > 256
          )
            return failure(
              'Settle takes exactly one deliveryId and settle: "not_delivered". Nothing dispatched.',
            );
          if (captain.settleSeatDelivery === undefined)
            return failure("Settling a delivery is unavailable here. Nothing dispatched.");
          try {
            // An MCP deliveryId names its native original through the seat-call receipt.
            let native = await captain.settleSeatDelivery(args.deliveryId, conversationId);
            const id = SeatCallIdSchema.safeParse(args.deliveryId);
            if (!native && id.success) {
              const original = receipts.read(id.data, "message_seat", lane, conversationId);
              for (const block of original.isError ? [] : original.content) {
                if (block.type !== "text" || native) continue;
                let body;
                try {
                  body = JSON.parse(block.text);
                } catch {
                  continue;
                }
                if (typeof body?.messageId === "string")
                  native = await captain.settleSeatDelivery(body.messageId, conversationId);
              }
            }
            return native
              ? { content: [{ type: "text", text: JSON.stringify(native) }] }
              : failure("No unresolved original delivery has that ID. Nothing dispatched.");
          } catch (error) {
            return failure(error);
          }
        }
        const keys = Object.keys(args);
        const key = keys[0];
        if (keys.length !== 1 || (key !== "deliveryId" && key !== "hireId"))
          return failure("Supply exactly one deliveryId or hireId. Nothing dispatched.");
        if (key === "deliveryId" && typeof args[key] === "string" && args[key].length <= 256) {
          try {
            const native = await captain.reconcileSeatDelivery?.(args[key], conversationId);
            if (native) return { content: [{ type: "text", text: JSON.stringify(native) }] };
          } catch (error) {
            return failure(error);
          }
        }
        const id = SeatCallIdSchema.safeParse(args[key]);
        if (!id.success) return failure("Invalid seat-call receipt ID. Nothing dispatched.");
        // The bridge names an ID it minted itself in this request's seat-call metadata.
        const minted = SeatCallRequestSchema.safeParse(request.params._meta?.[SEAT_CALL_META]);
        try {
          const original = receipts.read(
            id.data,
            key === "deliveryId" ? "message_seat" : "hire_agent",
            lane,
            conversationId,
            minted.success && minted.data.id === id.data,
          );
          if (key === "deliveryId" && !original.isError) {
            for (const block of original.content) {
              if (block.type !== "text") continue;
              let body;
              try {
                body = JSON.parse(block.text);
              } catch {
                continue;
              }
              if (
                (body?.outcome !== "unconfirmed" && body?.status !== "lead_service_queued") ||
                typeof body.messageId !== "string"
              )
                continue;
              const native = await captain.reconcileSeatDelivery?.(body.messageId, conversationId);
              if (native)
                return { content: [{ type: "text", text: JSON.stringify(native) }], _meta: original._meta };
            }
          }
          return original;
        } catch (error) {
          return failure(error);
        }
      }
      if (unlisted.length > 0 && request.params.name === "mcp_tool_search") {
        const result = await byName.get("mcp_tool_search")!.call(request.params.arguments ?? {});
        const merged = withUnlistedTools(result, request.params.arguments ?? {}, unlisted);
        return { content: [...merged.content], ...(merged.isError === true ? { isError: true } : {}) };
      }
      const offList =
        request.params.name === "mcp_tool_call" && typeof request.params.arguments?.name === "string"
          ? unlisted.find((tool) => tool.name === request.params.arguments?.name)
          : undefined;
      const tool = offList ?? byName.get(request.params.name);
      if (tool === undefined) {
        return {
          content: [{ type: "text" as const, text: `No tool named ${request.params.name} in this lane.` }],
          isError: true,
        };
      }
      const input = offList === undefined ? request.params.arguments : request.params.arguments?.arguments;
      const args =
        input !== null && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      const requestPriority = request.params._meta?.clankieRequestPriority;
      if (requestPriority !== undefined && requestPriority !== "background")
        return failure("Invalid request priority. Nothing dispatched.");
      const publication =
        tool.name === "mail_owner_update"
          ? OwnerUpdatePublicationSchema.safeParse(
              request.params._meta?.[OWNER_UPDATE_PUBLICATION_META] ?? { publicationId: randomUUID() },
            )
          : undefined;
      if (publication && !publication.success)
        return failure("Invalid owner-update publication identity. Nothing dispatched.");
      const publicationId = publication?.success ? publication.data.publicationId : undefined;
      const context = publicationId === undefined ? undefined : { callId: publicationId };
      const invoke = async () => {
        if (lane === "operator" && captain.operatorSeatMigrationHeld?.(conversationId ?? "global-default"))
          return failure(
            "operator_seat_migration_held: reconcile original receipts; no new tool was dispatched",
          );
        const call = () => (context === undefined ? tool.call(args) : tool.call(args, context));
        const result = await (requestPriority === "background"
          ? withLinearRequestPriority("background", call)
          : call());
        return {
          content: [...result.content],
          ...(result.isError === true ? { isError: true } : {}),
          ...(publicationId === undefined
            ? {}
            : { _meta: { [OWNER_UPDATE_PUBLICATION_META]: { publicationId } } }),
        };
      };
      const protectedTool = SeatCallToolSchema.safeParse(tool.name);
      if (!protectedTool.success) return invoke();
      const metadata = request.params._meta?.[SEAT_CALL_META];
      const identity = SeatCallRequestSchema.safeParse(metadata ?? { id: randomUUID() });
      if (!identity.success) return failure("Invalid seat-call identity. Nothing dispatched.");
      const id = identity.data.id;
      try {
        if (shutdown.signal.aborted) return failure("The service is shutting down. Nothing dispatched.");
        const original = receipts.begin(id, protectedTool.data, args, lane, conversationId);
        if (original !== undefined) return original;
      } catch (error) {
        return failure(error);
      }
      // Native execution may survive a transport shutdown. Retain its eventual
      // receipt, but release the HTTP caller with the exact pre-dispatch ID now.
      const operation = invoke()
        .then((result) => receipts.settle(id, result))
        .catch(() =>
          uncertainSeatCall(
            id,
            protectedTool.data,
            "The original dispatch did not return a durable result. Never resend; reconcile its receipt.",
          ),
        );
      let onShutdown!: () => void;
      const stopped = new Promise<ReturnType<typeof uncertainSeatCall>>((resolve) => {
        onShutdown = () =>
          resolve(
            uncertainSeatCall(
              id,
              protectedTool.data,
              "The service stopped while this dispatch was in flight. Its outcome is unknown; never resend.",
            ),
          );
        shutdown.signal.addEventListener("abort", onShutdown, { once: true });
        if (shutdown.signal.aborted) onShutdown();
      });
      try {
        return await Promise.race([operation, stopped]);
      } finally {
        shutdown.signal.removeEventListener("abort", onShutdown);
      }
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    // The SDK's own transports do not satisfy its `Transport` interface under
    // `exactOptionalPropertyTypes`, the same way the client transports do not
    // in `mcp-host.ts`. The cast stays at this one boundary.
    await server.connect(transport as unknown as Transport);
    return {
      transport,
      server,
      lane,
      ...(conversationId === undefined ? {} : { conversationId }),
      lastSeenAt: Date.now(),
      responses: new Set(),
    };
  };

  return {
    async handle(request, lane, conversationId) {
      if (shutdown.signal.aborted) return Response.json({ error: "service_stopping" }, { status: 503 });
      sweep();
      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId !== null) {
        const session = sessions.get(sessionId);
        if (session === undefined) return Response.json({ error: "unknown_session" }, { status: 404 });
        if (session.lane !== lane || session.conversationId !== conversationId)
          return Response.json({ error: "lane_forbidden" }, { status: 403 });
        session.lastSeenAt = Date.now();
        // During orderly shutdown, let protected POSTs publish their typed
        // uncertainty before SDK close aborts its handlers and loses the reply.
        const body: unknown =
          request.method === "POST"
            ? await request
                .clone()
                .json()
                .catch(() => undefined)
            : undefined;
        const protectedPost =
          typeof body === "object" &&
          body !== null &&
          "params" in body &&
          typeof body.params === "object" &&
          body.params !== null &&
          "name" in body.params &&
          SeatCallToolSchema.safeParse(body.params.name).success;
        const responsePromise = session.transport.handleRequest(request);
        if (protectedPost) session.responses.add(responsePromise);
        let response: Response;
        try {
          response = await responsePromise;
        } finally {
          session.responses.delete(responsePromise);
        }
        if (request.method === "DELETE" && response.ok) await dispose(sessionId, session);
        return response;
      }
      if (request.method !== "POST") {
        return Response.json({ error: "session_required" }, { status: 400 });
      }
      const session = await open(lane, conversationId);
      const response = await session.transport.handleRequest(request);
      const opened = session.transport.sessionId;
      // A rejected initialize leaves no session id; that server is dead weight.
      if (opened === undefined) await session.server.close();
      else sessions.set(opened, session);
      return response;
    },

    async close() {
      shutdown.abort();
      await Promise.allSettled([...sessions.values()].flatMap((session) => [...session.responses]));
      await Promise.all([...sessions].map(([id, session]) => dispose(id, session)));
    },
  };
}

function objectUnionRoot(schema: Record<string, unknown>): { type: "object" } {
  const variants = schema.anyOf ?? schema.oneOf;
  if (
    schema.type === undefined &&
    Array.isArray(variants) &&
    variants.length > 0 &&
    variants.every((variant) => typeof variant === "object" && variant !== null && variant.type === "object")
  ) {
    return { ...schema, type: "object" };
  }
  return schema as { type: "object" };
}

/**
 * `mcp_tool_search` over connected services, plus the lane's own tools this list
 * leaves out, in the same result shape: a name lookup returns their schemas, a
 * query ranks them by the words their name and description share with it.
 */
function withUnlistedTools(
  result: LaneToolResult,
  args: Record<string, unknown>,
  unlisted: readonly LaneTool[],
): LaneToolResult {
  const block = result.content[0];
  if (result.isError === true || block?.type !== "text") return result;
  let body: { tools?: unknown[]; missing?: string[] } & Record<string, unknown>;
  try {
    body = JSON.parse(block.text);
  } catch {
    return result;
  }
  const names = Array.isArray(args.names) ? args.names.filter((name) => typeof name === "string") : [];
  let tools: unknown[];
  let missing = body.missing;
  if (names.length > 0) {
    const found = unlisted.filter((tool) => names.includes(tool.name));
    tools = [
      ...(body.tools ?? []),
      ...found.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    ];
    missing = missing?.filter((name) => !found.some((tool) => tool.name === name));
  } else {
    const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    const terms = query.split(/[^a-z0-9]+/u).filter(Boolean);
    // The directory's own ranking: a term in the name counts twice, one in the
    // text once, and the exact name outranks everything.
    const score = (name: string, text: string) =>
      (name.toLowerCase() === query ? 100 : 0) +
      terms.reduce(
        (total, term) =>
          total + (name.toLowerCase().includes(term) ? 2 : text.toLowerCase().includes(term) ? 1 : 0),
        0,
      );
    const connected = (body.tools ?? []).map((tool) => {
      const entry = tool as { name?: unknown; summary?: unknown };
      return {
        tool,
        score: score(String(entry.name ?? ""), `${String(entry.name ?? "")} ${String(entry.summary ?? "")}`),
      };
    });
    const own = unlisted
      .map((tool) => ({
        tool: { name: tool.name, summary: tool.description.split("\n")[0]!.slice(0, 160) },
        score: score(tool.name, `${tool.name} ${tool.description}`),
      }))
      .filter((entry) => terms.length === 0 || entry.score > 0);
    // Rank both together before the shared cap, so a full connected page never hides them.
    tools = [...connected, ...own]
      .map((entry, order) => ({ ...entry, order }))
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, 20)
      .map((entry) => entry.tool);
  }
  const merged: Record<string, unknown> = { ...body, tools };
  if (missing?.length) merged.missing = missing;
  else delete merged.missing;
  return {
    ...result,
    content: [{ type: "text", text: JSON.stringify(merged) }, ...result.content.slice(1)],
  };
}
