/**
 * Clankie's own tools, served over streamable-HTTP MCP (VUH-1085).
 *
 * The bearer picks the lane, and the lane picks the tools: a connection sees
 * exactly that lane's authority plan, assembled by the captain's one registry.
 * MCP here is transport only — it grants nothing a pi session in the same lane
 * would not already hold.
 */
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CaptainSessionLaneV2 } from "@clankie/protocol";
import type { CaptainPort, LaneTool } from "./captain/port.ts";

/** How long an untouched session survives. Swept lazily, on the next request. */
const SESSION_IDLE_MS = 60 * 60_000;

interface LaneMcpSession {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly server: Server;
  readonly lane: CaptainSessionLaneV2;
  lastSeenAt: number;
}

export interface LaneMcpEndpoint {
  handle(request: Request, lane: CaptainSessionLaneV2): Promise<Response>;
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
 * bearer can never be driven by another. Sessions are in-memory: this endpoint
 * is a seam onto a live captain, and nothing about it survives a restart.
 */
export function createLaneMcpEndpoint({
  captain,
}: {
  captain: Pick<CaptainPort, "laneToolBank">;
}): LaneMcpEndpoint {
  const sessions = new Map<string, LaneMcpSession>();

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

  const open = async (lane: CaptainSessionLaneV2): Promise<LaneMcpSession> => {
    const bank = await captain.laneToolBank(lane);
    const byName = new Map<string, LaneTool>(bank.tools.map((tool) => [tool.name, tool]));
    const server = new Server(
      { name: "clankie", version: "0.2.0" },
      { capabilities: { tools: {} }, instructions: instructionsFor(lane) },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: bank.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as { type: "object" },
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = byName.get(request.params.name);
      if (tool === undefined) {
        return {
          content: [{ type: "text" as const, text: `No tool named ${request.params.name} in this lane.` }],
          isError: true,
        };
      }
      const result = await tool.call(request.params.arguments ?? {});
      return { content: [...result.content], ...(result.isError === true ? { isError: true } : {}) };
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
    });
    // The SDK's own transports do not satisfy its `Transport` interface under
    // `exactOptionalPropertyTypes`, the same way the client transports do not
    // in `mcp-host.ts`. The cast stays at this one boundary.
    await server.connect(transport as unknown as Transport);
    return { transport, server, lane, lastSeenAt: Date.now() };
  };

  return {
    async handle(request, lane) {
      sweep();
      const sessionId = request.headers.get("mcp-session-id");
      if (sessionId !== null) {
        const session = sessions.get(sessionId);
        if (session === undefined) return Response.json({ error: "unknown_session" }, { status: 404 });
        if (session.lane !== lane) return Response.json({ error: "lane_forbidden" }, { status: 403 });
        session.lastSeenAt = Date.now();
        const response = await session.transport.handleRequest(request);
        if (request.method === "DELETE" && response.ok) await dispose(sessionId, session);
        return response;
      }
      if (request.method !== "POST") {
        return Response.json({ error: "session_required" }, { status: 400 });
      }
      const session = await open(lane);
      const response = await session.transport.handleRequest(request);
      const opened = session.transport.sessionId;
      // A rejected initialize leaves no session id; that server is dead weight.
      if (opened === undefined) await session.server.close();
      else sessions.set(opened, session);
      return response;
    },

    async close() {
      await Promise.all([...sessions].map(([id, session]) => dispose(id, session)));
    },
  };
}
