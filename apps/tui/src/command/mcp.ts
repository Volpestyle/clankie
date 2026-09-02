/**
 * `clankie mcp --lane operator` — the stdio side of the seat
 * ([ADR 0152](../../../../docs/adr/0152-a-harness-takes-the-operator-seat.md)).
 *
 * A harness that takes the seat speaks MCP over stdio to whatever its config
 * names. This is that process: it resolves the lane's bearer from the broker,
 * opens the service's lane tool bank at `/v1/mcp` as a streamable-HTTP client,
 * and re-serves the same tools over stdin/stdout. No secret lands in a config
 * file, and the harness never learns the bearer.
 *
 * It is also his channel. While it runs it long-polls the seat's outbox and
 * pushes each wake, watch, or escalation into the session as a channel event;
 * that polling is what binds the seat as his head. A `reply` tool answers an
 * escalating room.
 *
 * stdout is the wire. Nothing here may print to it except JSON-RPC.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Notification,
  type Request,
  type Result,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  CaptainSessionLaneV2Schema,
  OPERATOR_SEAT_EVENTS_PATH,
  OperatorSeatEventsPageSchema,
  type CaptainSessionLaneV2,
  type OperatorSeatEvent,
} from "@clankie/protocol";
import { commandHost } from "./io.ts";

const MCP_USAGE = "Usage: clankie mcp [--lane operator]";
const REQUEST_TIMEOUT_MS = 10 * 60_000;
/** Under the outbox's bound window (45s), so a live bridge is always mid-poll or just back. */
const OUTBOX_POLL_WAIT_MS = 25_000;
const OUTBOX_RETRY_MS = 5_000;
const SEAT_CLIENT = { name: "clankie-seat", version: "0.2.0" } as const;
export const CHANNEL_NOTIFICATION_METHOD = "notifications/claude/channel";
const REPLY_TOOL_NAME = "reply";

const CHANNEL_INSTRUCTIONS =
  `Events tagged <channel source="clankie" kind="wake|watch|escalation" conversation="…" event_id="…"> are your own: ` +
  "a self-wake you scheduled, a herdr completion watch you armed, or a room handing you work. " +
  `Answer an escalation with the ${REPLY_TOOL_NAME} tool and its event_id; a wake or watch needs no reply.`;

/** The Claude Code channel event, typed so the server can send it. */
interface ChannelNotification extends Notification {
  readonly method: typeof CHANNEL_NOTIFICATION_METHOD;
  readonly params: { readonly content: string; readonly meta: Record<string, string> };
}

/** The service's lane tool bank and seat outbox as the bridge sees them, so tests can fake them. */
export interface LaneToolUpstream {
  readonly instructions?: string | undefined;
  listTools(): Promise<readonly Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** Long-poll the seat's outbox; empty when nothing arrived inside `waitMs`, or once `signal` aborts. */
  pollEvents(waitMs: number, signal?: AbortSignal): Promise<readonly OperatorSeatEvent[]>;
  /** Answer one escalation; false when the service no longer waits on it. */
  reply(eventId: string, text: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface McpCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly operatorCredentialStore?: CredentialStore;
  /** Test seam: the upstream to bridge instead of the live service. */
  readonly connectUpstream?: (input: { readonly lane: CaptainSessionLaneV2 }) => Promise<LaneToolUpstream>;
  /** Test seam: the transport to serve instead of stdio. */
  readonly transport?: Transport;
  readonly stderr?: { write(chunk: string): unknown };
}

export function parseMcpArgs(args: readonly string[]): { readonly lane: CaptainSessionLaneV2 } {
  let lane: CaptainSessionLaneV2 = "operator";
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag !== "--lane" || value === undefined) throw new Error(MCP_USAGE);
    const parsed = CaptainSessionLaneV2Schema.safeParse(value);
    if (!parsed.success) throw new Error(MCP_USAGE);
    lane = parsed.data;
  }
  return { lane };
}

const REPLY_TOOL: Tool = {
  name: REPLY_TOOL_NAME,
  description:
    'Answer a room that escalated to you: the event_id from the <channel kind="escalation"> tag and your reply, ' +
    "which goes back to that room as your own words.",
  inputSchema: {
    type: "object",
    properties: {
      event_id: {
        type: "string",
        description: "The event_id attribute of the escalation you are answering.",
      },
      text: { type: "string", description: "Your reply, in your own voice." },
    },
    required: ["event_id", "text"],
  },
};

/**
 * The stdio server: every tool the lane bank lists, called through to it, plus
 * the channel capability and the `reply` tool. The bank's own `instructions`
 * ride along so the harness hears the same framing a direct HTTP client would.
 */
export function createSeatBridge(
  upstream: LaneToolUpstream,
  lane: CaptainSessionLaneV2,
): Server<Request, ChannelNotification, Result> {
  const server = new Server<Request, ChannelNotification, Result>(
    { name: "clankie", version: "0.2.0" },
    {
      capabilities: { tools: {}, experimental: { "claude/channel": {} } },
      instructions: `${upstream.instructions ?? `Clankie's own tools, in his ${lane} lane.`}\n\n${CHANNEL_INSTRUCTIONS}`,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...(await upstream.listTools()), REPLY_TOOL],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== REPLY_TOOL_NAME) {
      return upstream.callTool(request.params.name, request.params.arguments ?? {});
    }
    const args = request.params.arguments ?? {};
    const eventId = typeof args.event_id === "string" ? args.event_id : "";
    const text = typeof args.text === "string" ? args.text.trim() : "";
    if (eventId.length === 0 || text.length === 0) {
      return { content: [{ type: "text", text: "reply needs event_id and text" }], isError: true };
    }
    const sent = await upstream.reply(eventId, text);
    return sent
      ? { content: [{ type: "text", text: "sent" }] }
      : {
          content: [
            { type: "text", text: "nothing is waiting on that event_id; the room may have moved on" },
          ],
          isError: true,
        };
  });
  return server;
}

/**
 * Pump the outbox into the session until the harness closes the bridge. A
 * poll that fails waits a little and asks again: the service restarting must
 * not cost him the seat.
 */
export async function pumpSeatEvents(
  server: Pick<Server<Request, ChannelNotification, Result>, "notification">,
  upstream: Pick<LaneToolUpstream, "pollEvents">,
  signal: AbortSignal,
  options: {
    readonly waitMs?: number;
    readonly retryMs?: number;
    readonly onError?: (error: unknown) => void;
  } = {},
): Promise<void> {
  const waitMs = options.waitMs ?? OUTBOX_POLL_WAIT_MS;
  const retryMs = options.retryMs ?? OUTBOX_RETRY_MS;
  while (!signal.aborted) {
    // A poll that answers at once (an empty page from a service that ignored
    // `wait`) must not spin the loop faster than the transport can deliver.
    await delay(0, signal);
    if (signal.aborted) return;
    let events: readonly OperatorSeatEvent[];
    try {
      events = await upstream.pollEvents(waitMs, signal);
    } catch (error) {
      if (signal.aborted) return;
      options.onError?.(error);
      await delay(retryMs, signal);
      continue;
    }
    for (const event of events) {
      if (signal.aborted) return;
      await server.notification({
        method: CHANNEL_NOTIFICATION_METHOD,
        params: {
          content: event.content,
          // Attribute keys must be identifiers; anything else Claude Code drops.
          meta: {
            kind: event.kind,
            conversation: event.conversationId,
            source: event.source,
            event_id: event.id,
            created_at: event.createdAt,
          },
        },
      });
    }
  }
}

/** Opens the service's `/v1/mcp` as a client and its seat outbox; the bearer rides every request. */
async function connectLaneUpstream(input: {
  readonly host: string;
  readonly bearer: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<LaneToolUpstream> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${input.bearer}` };
  const client = new Client(SEAT_CLIENT, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL("/v1/mcp", input.host), {
    requestInit: { headers },
  });
  // Same boundary cast as the service's own MCP host: the SDK's transports do
  // not satisfy its `Transport` interface under exactOptionalPropertyTypes.
  await client.connect(transport as unknown as Transport, { timeout: REQUEST_TIMEOUT_MS });
  return {
    instructions: client.getInstructions(),
    async listTools() {
      const collected: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor }, {
          timeout: REQUEST_TIMEOUT_MS,
        });
        collected.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return collected;
    },
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: REQUEST_TIMEOUT_MS,
      });
      return {
        content: Array.isArray(result.content) ? (result.content as CallToolResult["content"]) : [],
        ...(result.isError === true ? { isError: true } : {}),
      };
    },
    async pollEvents(waitMs, signal) {
      // The harness closing the bridge must not wait out a parked poll.
      const deadline = AbortSignal.timeout(waitMs + 10_000);
      const response = await fetchImpl(
        new URL(`${OPERATOR_SEAT_EVENTS_PATH}?wait=${String(waitMs)}`, input.host),
        { headers, signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]) },
      );
      if (!response.ok) throw new Error(`seat outbox answered ${String(response.status)}`);
      return OperatorSeatEventsPageSchema.parse(await response.json()).events;
    },
    async reply(eventId, text) {
      const response = await fetchImpl(
        new URL(`${OPERATOR_SEAT_EVENTS_PATH}/${encodeURIComponent(eventId)}/reply`, input.host),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: 1, text }),
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`seat reply answered ${String(response.status)}`);
      return true;
    },
    close: () => client.close(),
  };
}

export async function runMcpCommand(
  args: readonly string[],
  options: McpCommandOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const { lane } = parseMcpArgs(args);
  const stderr = options.stderr ?? process.stderr;
  const upstream = await (options.connectUpstream ?? defaultUpstream)({ lane });
  const server = createSeatBridge(upstream, lane);
  const transport = options.transport ?? new StdioServerTransport();
  const closing = new AbortController();
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => {
      closing.abort();
      resolve();
    };
  });
  await server.connect(transport);
  stderr.write(`clankie mcp: serving the ${lane} lane over stdio\n`);
  const pump =
    lane === "operator"
      ? pumpSeatEvents(server, upstream, closing.signal, {
          onError: (error) => {
            stderr.write(
              `clankie mcp: outbox poll failed (${error instanceof Error ? error.message : String(error)}); retrying\n`,
            );
          },
        }).catch(() => undefined)
      : Promise.resolve();
  // The harness owns this process: when it closes stdin the bridge is done.
  await closed;
  await pump;
  await upstream.close().catch(() => undefined);
  return 0;

  async function defaultUpstream(input: { readonly lane: CaptainSessionLaneV2 }): Promise<LaneToolUpstream> {
    // Only the operator's own bearer lives in this broker; a social lane's
    // bearer belongs to the Discord bridge process and is never handed out here.
    if (input.lane !== "operator") {
      throw new Error(
        `The ${input.lane} lane has no bearer on this side; the seat serves the operator lane.`,
      );
    }
    const credential = await resolveOperatorCredential({
      env,
      ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
    });
    if (credential === undefined) {
      throw new Error("No operator credential is available; start the clankie service once first.");
    }
    return connectLaneUpstream({ host: commandHost({ ...options, env }), bearer: credential.token });
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
