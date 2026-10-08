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
import type { CaptainPort, LaneTool } from "./captain/port.ts";
import { assertMcpToolsList } from "./mcp-tool-schema.ts";
import { SeatCallReceipts } from "./seat-call-receipts.ts";

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

function instructionsFor(lane: CaptainSessionLaneV2): string {
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
  captain: Pick<CaptainPort, "laneToolBank">;
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
      "Read the original operator message_seat or hire_agent receipt by its MCP deliveryId or hireId. " +
      "Read-only: never dispatches, retries, or starts an agent. Use the same conversation as the original call.",
    inputSchema: {
      type: "object" as const,
      properties: {
        deliveryId: { type: "string", format: "uuid" },
        hireId: { type: "string", format: "uuid" },
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
    const bank = await captain.laneToolBank(lane, conversationId);
    const byName = new Map<string, LaneTool>(bank.tools.map((tool) => [tool.name, tool]));
    const server = new Server(
      { name: "clankie", version: "0.2.0" },
      { capabilities: { tools: {} }, instructions: instructionsFor(lane) },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => {
      const result = {
        tools: [
          ...bank.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            // TypeBox's union of objects omits its root type. Only those
            // unions are adapted; an invalid authored root must stay visible.
            inputSchema: objectUnionRoot(tool.inputSchema),
          })),
          ...(lane === "operator" ? [reconciliationTool] : []),
        ],
      };
      assertMcpToolsList(result, `${lane} lane`);
      return result;
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name === RECONCILE_SEAT_CALL && lane === "operator") {
        const args = request.params.arguments ?? {};
        const keys = Object.keys(args);
        const key = keys[0];
        if (keys.length !== 1 || (key !== "deliveryId" && key !== "hireId"))
          return failure("Supply exactly one deliveryId or hireId. Nothing dispatched.");
        const id = SeatCallIdSchema.safeParse(args[key]);
        if (!id.success) return failure("Invalid seat-call receipt ID. Nothing dispatched.");
        try {
          return receipts.read(
            id.data,
            key === "deliveryId" ? "message_seat" : "hire_agent",
            lane,
            conversationId,
          );
        } catch (error) {
          return failure(error);
        }
      }
      const tool = byName.get(request.params.name);
      if (tool === undefined) {
        return {
          content: [{ type: "text" as const, text: `No tool named ${request.params.name} in this lane.` }],
          isError: true,
        };
      }
      const args = request.params.arguments ?? {};
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
