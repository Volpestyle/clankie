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
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { CaptainSessionLaneV2Schema, type CaptainSessionLaneV2 } from "@clankie/protocol";
import { commandHost } from "./io.ts";

const MCP_USAGE = "Usage: clankie mcp [--lane operator]";
const REQUEST_TIMEOUT_MS = 10 * 60_000;
const SEAT_CLIENT = { name: "clankie-seat", version: "0.2.0" } as const;

/** The service's lane tool bank as the bridge sees it, so tests can fake it. */
export interface LaneToolUpstream {
  readonly instructions?: string | undefined;
  listTools(): Promise<readonly Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
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

/**
 * The stdio server: every tool the lane bank lists, called through to it. The
 * bank's own `instructions` ride along so the harness hears the same framing a
 * direct HTTP client would.
 */
export function createSeatBridge(upstream: LaneToolUpstream, lane: CaptainSessionLaneV2): Server {
  const server = new Server(
    { name: "clankie", version: "0.2.0" },
    {
      capabilities: { tools: {} },
      instructions: upstream.instructions ?? `Clankie's own tools, in his ${lane} lane.`,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...(await upstream.listTools())],
  }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    upstream.callTool(request.params.name, request.params.arguments ?? {}),
  );
  return server;
}

/** Opens the service's `/v1/mcp` as a client; the bearer rides every request. */
async function connectLaneUpstream(input: {
  readonly host: string;
  readonly bearer: string;
}): Promise<LaneToolUpstream> {
  const client = new Client(SEAT_CLIENT, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL("/v1/mcp", input.host), {
    requestInit: { headers: { authorization: `Bearer ${input.bearer}` } },
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
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
  await server.connect(transport);
  stderr.write(`clankie mcp: serving the ${lane} lane over stdio\n`);
  // The harness owns this process: when it closes stdin the bridge is done.
  await closed;
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
