/**
 * `clankie mcp --lane operator` and `clankie mcp --seat` — stdio MCP for a
 * seated harness ([ADR 0152](../../../../docs/adr/0152-a-harness-takes-the-operator-seat.md)).
 *
 * `--lane` is the operator seat: it resolves the lane's bearer from the broker,
 * opens the service's lane tool bank at `/v1/mcp` as a streamable-HTTP client,
 * and re-serves the same tools over stdin/stdout. No secret lands in a config
 * file, and the harness never learns the bearer. It is also his channel: while
 * it runs it long-polls the seat's outbox and pushes each wake, watch, or
 * escalation into the session as a channel event; that polling is what binds
 * the seat as his head. A `reply` tool answers an escalating room.
 *
 * `--seat` is a fleet pane's mailbox: no tools, no `/v1/mcp` client, only the
 * channel. Identity is `HERDR_PANE_ID`. The bridge polls only when that pane
 * id is set *and* the parent `claude` argv loaded this server as a channel
 * (`--dangerously-load-development-channels` immediately followed by
 * `server:clankie-seat`, including the `=` form). Otherwise it serves an
 * empty channel and does not poll, so a user-scoped registration cannot
 * bind the mailbox in a session that will drop the notifications.
 *
 * stdout is the wire. Nothing here may print to it except JSON-RPC.
 */
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
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
  CLAUDE_WORKER_PLUGIN_ID,
  FLEET_SEAT_MCP_SERVER,
  OPERATOR_CONVERSATION_TEXT_MAX,
  OPERATOR_SEAT_EVENTS_PATH,
  OperatorSeatEventsPageSchema,
  fleetSeatEventsPath,
  fleetSeatMessagesPath,
  type CaptainSessionLaneV2,
  type OperatorSeatEvent,
} from "@clankie/protocol";
import { commandHost } from "./io.ts";
import { runWorkerMcp, runSwarmWorkerMcp, runEnrolledWorkerMcp } from "./worker-mcp.ts";

const execFileAsync = promisify(execFileCallback);
const MCP_USAGE =
  "Usage: clankie mcp [--lane operator [--conversation ID] | --seat | --grant FILE | --swarm-grant ID | --swarm]";
const FLEET_CHANNEL_SERVER = `server:${FLEET_SEAT_MCP_SERVER}`;
/** A hired seat's worker plugin channel (VUH-1458), approved under `--channels`. */
const WORKER_CHANNEL_PLUGIN = `plugin:${CLAUDE_WORKER_PLUGIN_ID}`;
const OPERATOR_CHANNEL_ENTRIES = [
  "plugin:clankie@inline",
  "plugin:clankie@clankie",
  "server:clankie",
] as const;
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

const FLEET_CHANNEL_INSTRUCTIONS =
  `Events tagged <channel source="clankie" kind="message" conversation="…" event_id="…"> ` +
  "are a message from the operator or a group chat addressed to this agent. " +
  "Answer it in the normal reply as if it had been typed into the pane. There is no tool to call.";

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

/** The fleet mailbox as the seat bridge sees it: poll and close, no tools. */
type FleetMailboxUpstream = Pick<LaneToolUpstream, "pollEvents" | "close">;

export interface McpCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly operatorCredentialStore?: CredentialStore;
  /** Test seam: the upstream to bridge instead of the live service. */
  readonly connectUpstream?: (input: {
    readonly lane: CaptainSessionLaneV2;
    readonly conversationId?: string;
  }) => Promise<LaneToolUpstream>;
  /** Test seam: the fleet mailbox to poll instead of the live service. */
  readonly connectSeatUpstream?: (input: { readonly paneId: string }) => Promise<FleetMailboxUpstream>;
  /** Test seam: the transport to serve instead of stdio. */
  readonly transport?: Transport;
  readonly stderr?: { write(chunk: string): unknown };
  /** Test seam: override the outbox long-poll window. */
  readonly pollWaitMs?: number;
  /** Test seam: override the failed-poll retry delay. */
  readonly pollRetryMs?: number;
  /** Test seam: the parent `claude` argv instead of `ps` on `process.ppid`. */
  readonly readParentArgv?: () => Promise<string | undefined>;
}

export type McpArgs =
  | { readonly lane: CaptainSessionLaneV2; readonly conversationId?: string }
  | { readonly seat: true }
  | { readonly swarm: true }
  | { readonly swarmGrant: string }
  | { readonly grantFile: string };

export function parseMcpArgs(args: readonly string[]): McpArgs {
  if (args.length === 1 && args[0] === "--swarm") return { swarm: true };
  if (args.length === 2 && args[0] === "--swarm-grant" && args[1]?.trim()) return { swarmGrant: args[1] };
  if (args.length === 2 && args[0] === "--grant" && args[1]?.trim()) return { grantFile: args[1] };
  let conversationId: string | undefined;
  let seat = false;
  let lane: CaptainSessionLaneV2 | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--seat") {
      seat = true;
      continue;
    }
    if (flag === "--conversation") {
      const value = args[++index]?.trim();
      if (!value || value.startsWith("--")) throw new Error(MCP_USAGE);
      conversationId = value;
      continue;
    }
    if (flag === "--lane") {
      const value = args[index + 1];
      if (value === undefined) throw new Error(MCP_USAGE);
      const parsed = CaptainSessionLaneV2Schema.safeParse(value);
      if (!parsed.success) throw new Error(MCP_USAGE);
      lane = parsed.data;
      index += 1;
      continue;
    }
    throw new Error(MCP_USAGE);
  }
  if (seat && (lane !== undefined || conversationId !== undefined)) throw new Error(MCP_USAGE);
  if (seat) return { seat: true };
  return { lane: lane ?? "operator", ...(conversationId === undefined ? {} : { conversationId }) };
}

/**
 * Whether a parent `claude` command line loaded this fleet server as a
 * channel. Poll only when `--dangerously-load-development-channels` is
 * present and the token immediately after it is `server:clankie-seat`
 * (or the `=` form of that pair). `--channels` is not a bind: Claude Code
 * rejects `server:` entries under it, so polling there is a black hole.
 */
export function parentArgvLoadsFleetChannel(argv: string | undefined, workerPlugin = false): boolean {
  // A globally registered clankie-seat can run beside the worker plugin.
  // Only the selected server may consume the mailbox; Claude drops events
  // from the other connection even though both advertise the capability.
  return workerPlugin
    ? parentArgvApprovesChannel(argv, WORKER_CHANNEL_PLUGIN)
    : parentArgvLoadsChannel(argv, FLEET_CHANNEL_SERVER);
}

/**
 * Whether `--channels` names this approved plugin entry. Unlike the
 * development flag, it takes plugin entries only, and the owner's managed
 * policy decides whether Claude honors them.
 */
function parentArgvApprovesChannel(argv: string | undefined, entry: string): boolean {
  if (argv === undefined) return false;
  const tokens = argv.trim().split(/\s+/u);
  if (tokens.includes("--print") || tokens.includes("-p")) return false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.startsWith("--channels=")) return token.slice("--channels=".length).split(",").includes(entry);
    if (token !== "--channels") continue;
    for (const value of tokens.slice(index + 1)) {
      if (value.startsWith("-")) break;
      if (value.split(",").includes(entry)) return true;
    }
  }
  return false;
}

function parentArgvLoadsChannel(argv: string | undefined, entry: string): boolean {
  if (argv === undefined) return false;
  const tokens = argv
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  // Claude's print mode connects MCP tools but does not register channel
  // notifications. Polling there would consume mail without delivering it.
  if (tokens.includes("--print") || tokens.includes("-p")) return false;
  const flag = "--dangerously-load-development-channels";
  const assigned = `${flag}=`;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.startsWith(assigned)) return token.slice(assigned.length) === entry;
    if (token === flag) return tokens[index + 1] === entry;
  }
  return false;
}

async function defaultReadParentArgv(): Promise<string | undefined> {
  const ppid = process.ppid;
  if (!Number.isInteger(ppid) || ppid <= 1) return undefined;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "args=", "-p", String(ppid)], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const argv = String(stdout).trim();
    return argv.length === 0 ? undefined : argv;
  } catch {
    return undefined;
  }
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
export async function connectLaneUpstream(input: {
  readonly host: string;
  readonly bearer: string;
  readonly conversationId?: string;
  readonly fetchImpl?: typeof fetch;
}): Promise<LaneToolUpstream> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${input.bearer}` };
  const urlFor = (path: string) => {
    const url = new URL(path, input.host);
    if (input.conversationId !== undefined) url.searchParams.set("conversationId", input.conversationId);
    return url;
  };
  class ExpiredSeatSession extends Error {}
  let closed = false;
  const connect = async () => {
    const next = new Client(SEAT_CLIENT, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(urlFor("/v1/mcp"), {
      requestInit: { headers },
      fetch: async (url, init) => {
        const response = await fetchImpl(url, init);
        // This explicit rejection happens before tool admission. Network errors,
        // generic 404s and lost results must never replay a potentially run tool.
        if (init?.method === "POST" && response.status === 404) {
          const body: unknown = await response
            .clone()
            .json()
            .catch(() => undefined);
          if (
            typeof body === "object" &&
            body !== null &&
            "error" in body &&
            body.error === "unknown_session"
          ) {
            throw new ExpiredSeatSession("The service restarted its MCP session");
          }
        }
        return response;
      },
    });
    try {
      await next.connect(transport as unknown as Transport, { timeout: REQUEST_TIMEOUT_MS });
      return next;
    } catch (error) {
      await next.close().catch(() => undefined);
      throw error;
    }
  };
  let client = await connect();
  let reconnecting: Promise<void> | undefined;
  const request = async <T>(operation: (active: Client) => Promise<T>): Promise<T> => {
    if (closed) throw new Error("Seat bridge is closed");
    const previous = client;
    try {
      return await operation(previous);
    } catch (error) {
      if (!(error instanceof ExpiredSeatSession) || closed) throw error;
      if (client === previous) {
        reconnecting ??= (async () => {
          const next = await connect();
          if (closed) {
            await next.close();
            throw new Error("Seat bridge is closed");
          }
          client = next;
          await previous.close().catch(() => undefined);
        })().finally(() => {
          reconnecting = undefined;
        });
        await reconnecting;
      }
      return await operation(client);
    }
  };
  return {
    instructions: client.getInstructions(),
    async listTools() {
      const collected: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await request((active) =>
          active.listTools(cursor === undefined ? {} : { cursor }, {
            timeout: REQUEST_TIMEOUT_MS,
          }),
        );
        collected.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return collected;
    },
    async callTool(name, args) {
      const result = await request((active) =>
        active.callTool({ name, arguments: args }, undefined, {
          timeout: REQUEST_TIMEOUT_MS,
        }),
      );
      return {
        content: Array.isArray(result.content) ? (result.content as CallToolResult["content"]) : [],
        ...(result.isError === true ? { isError: true } : {}),
      };
    },
    async pollEvents(waitMs, signal) {
      // The harness closing the bridge must not wait out a parked poll.
      const deadline = AbortSignal.timeout(waitMs + 10_000);
      const response = await fetchImpl(urlFor(`${OPERATOR_SEAT_EVENTS_PATH}?wait=${String(waitMs)}`), {
        headers,
        signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
      });
      if (!response.ok) throw new Error(`seat outbox answered ${String(response.status)}`);
      return OperatorSeatEventsPageSchema.parse(await response.json()).events;
    },
    async reply(eventId, text) {
      const response = await fetchImpl(
        urlFor(`${OPERATOR_SEAT_EVENTS_PATH}/${encodeURIComponent(eventId)}/reply`),
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
    close: async () => {
      closed = true;
      await reconnecting?.catch(() => undefined);
      await client.close();
    },
  };
}

/**
 * A fleet pane's channel: no tools, no reply, no lane bank. Events tagged
 * `kind="message"` are answered in the normal reply.
 */
/** The one tool a fleet seat has (ADR 0213 phase 2): writing to Clankie first. */
const MESSAGE_CLANKIE_TOOL = {
  name: "message_clankie",
  description:
    "Send Clankie, the agent leading this machine's fleet, a message from this agent: a question, a blocker, or news he should hear now. He answers in this session if he chooses to.",
  inputSchema: {
    type: "object" as const,
    properties: { text: { type: "string", description: "What to tell him." } },
    required: ["text"],
    additionalProperties: false,
  },
};

/**
 * A fleet pane's MCP server: its mailbox as a channel, and `message_clankie`
 * when `send` can reach his service. He reads that message as this agent's
 * output, never as the owner's instruction.
 */
export function createFleetSeatBridge(
  send?: (text: string) => Promise<boolean>,
): Server<Request, ChannelNotification, Result> {
  const server = new Server<Request, ChannelNotification, Result>(
    { name: FLEET_SEAT_MCP_SERVER, version: "0.3.0" },
    {
      capabilities: { tools: {}, experimental: { "claude/channel": {} } },
      instructions:
        send === undefined
          ? FLEET_CHANNEL_INSTRUCTIONS
          : `${FLEET_CHANNEL_INSTRUCTIONS} To write to Clankie yourself, use the ${MESSAGE_CLANKIE_TOOL.name} tool.`,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: send === undefined ? [] : [MESSAGE_CLANKIE_TOOL],
  }));
  if (send !== undefined)
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== MESSAGE_CLANKIE_TOOL.name)
        return { content: [{ type: "text", text: `Unknown tool ${request.params.name}` }], isError: true };
      const text = String((request.params.arguments as { text?: unknown } | undefined)?.text ?? "").trim();
      if (text === "") return { content: [{ type: "text", text: "Say what to tell him." }], isError: true };
      const sent = await send(text.slice(0, OPERATOR_CONVERSATION_TEXT_MAX)).catch(() => false);
      return sent
        ? { content: [{ type: "text", text: "Sent to Clankie." }] }
        : { content: [{ type: "text", text: "Could not reach Clankie; not sent." }], isError: true };
    });
  return server;
}

/** Long-poll one pane's fleet mailbox; a 404 is a failed poll the pump retries. */
function connectFleetMailbox(input: {
  readonly host: string;
  readonly bearer: string;
  readonly paneId: string;
  readonly fetchImpl?: typeof fetch;
}): FleetMailboxUpstream {
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${input.bearer}` };
  return {
    async pollEvents(waitMs, signal) {
      const deadline = AbortSignal.timeout(waitMs + 10_000);
      const response = await fetchImpl(
        new URL(`${fleetSeatEventsPath(input.paneId)}?wait=${String(waitMs)}`, input.host),
        { headers, signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]) },
      );
      if (!response.ok) throw new Error(`fleet mailbox answered ${String(response.status)}`);
      return OperatorSeatEventsPageSchema.parse(await response.json()).events;
    },
    close: async () => undefined,
  };
}

function pollCadence(options: McpCommandOptions) {
  return {
    ...(options.pollWaitMs === undefined ? {} : { waitMs: options.pollWaitMs }),
    ...(options.pollRetryMs === undefined ? {} : { retryMs: options.pollRetryMs }),
  };
}

function fleetMailboxOnError(stderr: { write(chunk: string): unknown }): (error: unknown) => void {
  let warnedUnknownSeat = false;
  return (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("404")) {
      if (!warnedUnknownSeat) {
        warnedUnknownSeat = true;
        stderr.write("clankie mcp: fleet mailbox not ready yet (unknown_seat); retrying\n");
      }
      return;
    }
    stderr.write(`clankie mcp: fleet mailbox poll failed (${message}); retrying\n`);
  };
}

async function runFleetSeatMcp(options: McpCommandOptions): Promise<number> {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;
  const paneId = env.HERDR_PANE_ID?.trim() ?? "";
  const server = createFleetSeatBridge(
    paneId.length === 0
      ? undefined
      : async (text) => {
          const credential = await resolveOperatorCredential({
            env,
            ...(options.operatorCredentialStore === undefined
              ? {}
              : { store: options.operatorCredentialStore }),
          });
          if (credential === undefined) return false;
          const response = await fetch(
            new URL(fleetSeatMessagesPath(paneId), commandHost({ ...options, env })),
            {
              method: "POST",
              headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
              body: JSON.stringify({ schemaVersion: 1, text }),
              signal: AbortSignal.timeout(20_000),
            },
          );
          return response.ok;
        },
  );
  const transport = options.transport ?? new StdioServerTransport();
  const closing = new AbortController();
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => {
      closing.abort();
      resolve();
    };
  });

  if (paneId.length === 0) {
    await server.connect(transport);
    stderr.write("clankie mcp: --seat needs HERDR_PANE_ID; serving an empty channel\n");
    await closed;
    return 0;
  }

  let parentArgv: string | undefined;
  try {
    // Served by the clankie-worker plugin, this bridge's parent is the plugin's
    // wrapper, which hands over Claude's own argv (VUH-1458).
    const handed = env.CLANKIE_SEAT_PARENT_ARGV?.trim();
    parentArgv = await (options.readParentArgv ?? (handed ? async () => handed : defaultReadParentArgv))();
  } catch {
    parentArgv = undefined;
  }
  if (!parentArgvLoadsFleetChannel(parentArgv, env.CLANKIE_SEAT_PARENT_ARGV !== undefined)) {
    await server.connect(transport);
    stderr.write("clankie mcp: channel not loaded for this session; not polling\n");
    await closed;
    return 0;
  }

  const upstream = await (options.connectSeatUpstream ?? defaultSeatUpstream)({ paneId });
  await server.connect(transport);
  stderr.write(`clankie mcp: serving the fleet seat channel for pane ${paneId}\n`);
  const pump = pumpSeatEvents(server, upstream, closing.signal, {
    ...pollCadence(options),
    onError: fleetMailboxOnError(stderr),
  }).catch(() => undefined);
  await closed;
  await pump;
  await upstream.close().catch(() => undefined);
  return 0;

  async function defaultSeatUpstream(input: { readonly paneId: string }): Promise<FleetMailboxUpstream> {
    const credential = await resolveOperatorCredential({
      env,
      ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
    });
    if (credential === undefined) {
      throw new Error("No operator credential is available; start the clankie service once first.");
    }
    return connectFleetMailbox({
      host: commandHost({ ...options, env }),
      bearer: credential.token,
      paneId: input.paneId,
    });
  }
}

export async function runMcpCommand(
  args: readonly string[],
  options: McpCommandOptions = {},
): Promise<number> {
  const parsed = parseMcpArgs(args);
  if ("swarm" in parsed) return runEnrolledWorkerMcp(options);
  if ("swarmGrant" in parsed) return runSwarmWorkerMcp(parsed.swarmGrant, options);
  if ("grantFile" in parsed) return runWorkerMcp(parsed.grantFile, options.transport);
  if ("seat" in parsed) return runFleetSeatMcp(options);

  const env = options.env ?? process.env;
  const { lane } = parsed;
  const conversationId = parsed.conversationId ?? env.CLANKIE_CONVERSATION_ID;
  if (conversationId !== undefined && (lane !== "operator" || !conversationId.trim()))
    throw new Error(MCP_USAGE);
  const stderr = options.stderr ?? process.stderr;
  const parentArgv = await (options.readParentArgv ?? defaultReadParentArgv)().catch(() => undefined);
  // `clankie seat` loads the projected plugin as the session-only
  // `clankie@inline`; an installed marketplace copy is `clankie@clankie`.
  const channel = OPERATOR_CHANNEL_ENTRIES.some((entry) => parentArgvLoadsChannel(parentArgv, entry));
  const upstream = await (options.connectUpstream ?? defaultUpstream)({
    lane,
    ...(conversationId === undefined ? {} : { conversationId }),
  });
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
    lane === "operator" && channel
      ? pumpSeatEvents(server, upstream, closing.signal, {
          ...pollCadence(options),
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

  async function defaultUpstream(input: {
    readonly lane: CaptainSessionLaneV2;
    readonly conversationId?: string;
  }): Promise<LaneToolUpstream> {
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
    return connectLaneUpstream({
      host: commandHost({ ...options, env }),
      bearer: credential.token,
      ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    });
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
