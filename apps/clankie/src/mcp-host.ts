/**
 * Clankie's MCP client ([ADR 0109](../../../docs/adr/0109-mcp-is-how-he-reaches-a-service.md)).
 *
 * The service owns every MCP connection, the way it already owns the browser's
 * ([ADR 0082](../../../docs/adr/0082-clankie-holds-the-browser.md)): the captain
 * asks this host for a catalog and calls tools through it, and never holds a
 * transport or a token itself.
 *
 * Two kinds of server arrive here. **Curated connectors** ship with Clankie and
 * appear the moment their broker credential exists — `/connect linear` is the
 * whole setup. **Owner-authored servers** come from `settings.mcp.servers` for
 * everything he was not shipped knowing about.
 *
 * Three properties are the reason this is a host and not a `new Client()` at
 * each call site:
 *
 * - **Lane.** Every server declares which rooms may reach it, and the gate is
 *   checked when the catalog is built *and* again at call time.
 * - **Credentials.** Secrets stay broker-owned. An http server's bearer is
 *   resolved per request, so a token that expires mid-session refreshes instead
 *   of failing; a stdio server's is injected into its environment at spawn.
 * - **Untrusted text.** A server's own tool descriptions become prompt text, so
 *   they are length-capped here rather than trusted to be reasonable.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { LINEAR_MCP_RESOURCE, resolveProviderBearer, type CredentialStore } from "@clankie/credential-broker";
import type { CaptainSessionLaneV2 } from "@clankie/protocol";
import type { McpServerSettings, SettingsStore } from "@clankie/settings";

/** Matches the browser host's ceiling; pi truncates again on the way out. */
const MAX_RESULT_CHARACTERS = 50_000;
const MAX_DESCRIPTION_CHARACTERS = 4_000;
const CONNECT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;
/**
 * How long a failed connection is remembered before the next call retries.
 *
 * Without it a dead stdio server is respawned on every tool call, which turns a
 * typo in `command` into a process storm. Without an expiry at all, an owner
 * who fixes the typo would have to restart the service to be believed.
 */
const FAILURE_COOLDOWN_MS = 60_000;
/** How long the resolved server list is reused before settings are read again. */
const SERVER_LIST_TTL_MS = 5_000;

export interface McpHostLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

/** One tool on one server, named as the captain will register it. */
export interface McpToolDescriptor {
  readonly server: string;
  /** The tool's name on its server, as `tools/call` expects it. */
  readonly name: string;
  /** `${server}_${name}` — unique across servers and the authored bank. */
  readonly qualifiedName: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Whether this one is active from the first turn rather than found by search. */
  readonly initial: boolean;
}

export type McpRefusalReason = "unknown_server" | "lane_denied" | "server_unavailable";

export type McpCallResult =
  | { readonly outcome: "ok"; readonly content: string; readonly isError: boolean }
  | { readonly outcome: "refused"; readonly reason: McpRefusalReason; readonly detail: string };

export interface McpHost {
  /**
   * Connects every active server up front, so no conversational turn pays for
   * it. Failures are logged, never thrown: a server that is down costs him that
   * server's tools, not his ability to answer.
   */
  warm(): Promise<void>;
  /** Every tool reachable from `lane`, across every enabled server. */
  catalog(lane: CaptainSessionLaneV2): Promise<readonly McpToolDescriptor[]>;
  call(input: {
    readonly lane: CaptainSessionLaneV2;
    readonly server: string;
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
  }): Promise<McpCallResult>;
  close(): Promise<void>;
}

/**
 * Connectors Clankie ships knowing about. They need no settings entry: storing
 * the credential is the whole act of connecting, which is what makes `/connect`
 * a catalog rather than a place to paste a command line.
 *
 * Linear is reached at the same endpoint its OAuth tokens are minted for
 * (`mcp.linear.app/mcp`, see `linear-oauth.ts`) and stays available in every
 * room — connecting a tracker you cannot ask about from a room is pointless.
 */
export const CURATED_MCP_SERVERS: readonly McpServerSettings[] = [
  {
    id: "linear",
    transport: "http",
    url: LINEAR_MCP_RESOURCE,
    args: [],
    lane: "everywhere",
    credential: "linear",
    // Linear's server advertises far more than a room conversation needs. These
    // are the ones the authored `linear_*` tools used to cover; the rest are a
    // `mcp_tool_search` away.
    initialTools: [
      "list_issues",
      "get_issue",
      "create_issue",
      "update_issue",
      "list_comments",
      "create_comment",
      "list_teams",
      "list_projects",
    ],
    enabled: true,
  },
];

export interface McpHostOptions {
  readonly credentials: CredentialStore;
  readonly settings: SettingsStore;
  readonly logger: McpHostLogger;
  /** Overrides the curated list in tests so no suite reaches the network. */
  readonly curated?: readonly McpServerSettings[];
  /** Injected in tests; the real one connects a transport. */
  readonly connect?: (server: McpServerSettings, credentials: CredentialStore) => Promise<McpConnection>;
}

/** The part of an MCP client this host uses, so tests can supply a fake. */
export interface McpConnection {
  listTools(): Promise<readonly { name: string; description?: string | undefined; inputSchema?: unknown }[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>;
  close(): Promise<void>;
}

interface ServerState {
  connection?: McpConnection;
  connecting?: Promise<McpConnection>;
  tools?: readonly McpToolDescriptor[];
  failure?: { reason: string; at: number };
}

/** Whether a server declared for `lane` may be reached from this room. */
export function laneAllows(server: McpServerSettings, lane: CaptainSessionLaneV2): boolean {
  return server.lane === "everywhere" || lane === "operator";
}

export function createMcpHost(options: McpHostOptions): McpHost {
  const connectImpl = options.connect ?? connectServer;
  const curated = options.curated ?? CURATED_MCP_SERVERS;
  const states = new Map<string, ServerState>();
  let resolved: { servers: readonly McpServerSettings[]; at: number } | undefined;

  /**
   * The servers in play right now: curated ones whose credential exists, plus
   * whatever the owner authored. Recomputed rather than fixed at boot so
   * connecting a service mid-session works without a restart, exactly as the
   * authored connector tools already did.
   *
   * The short memo matters more than it looks: resolving this reads the
   * Keychain once per curated connector, and on macOS each read is a `security`
   * subprocess. Without it a single turn's tool calls spawn a handful.
   */
  async function activeServers(now: number): Promise<readonly McpServerSettings[]> {
    if (resolved !== undefined && now - resolved.at < SERVER_LIST_TTL_MS) return resolved.servers;
    const servers = await computeActiveServers();
    resolved = { servers, at: now };
    return servers;
  }

  async function computeActiveServers(): Promise<readonly McpServerSettings[]> {
    const settings = await options.settings.load();
    const authored = settings.mcp.servers.filter((server) => server.enabled);
    const authoredIds = new Set(authored.map((server) => server.id));
    const available: McpServerSettings[] = [];
    for (const server of curated) {
      // An owner entry with the same id wins: that is how a curated default
      // gets overridden rather than duplicated.
      if (authoredIds.has(server.id)) continue;
      if (server.credential !== undefined) {
        const stored = await options.credentials.get(server.credential);
        if (stored === undefined) continue;
      }
      available.push(server);
    }
    return [...available, ...authored];
  }

  function stateFor(id: string): ServerState {
    const existing = states.get(id);
    if (existing !== undefined) return existing;
    const created: ServerState = {};
    states.set(id, created);
    return created;
  }

  async function connection(server: McpServerSettings, now: number): Promise<McpConnection> {
    const state = stateFor(server.id);
    if (state.connection !== undefined) return state.connection;
    if (state.connecting !== undefined) return state.connecting;
    if (state.failure !== undefined && now - state.failure.at < FAILURE_COOLDOWN_MS) {
      throw new Error(state.failure.reason);
    }
    const attempt = connectImpl(server, options.credentials)
      .then((client) => {
        state.connection = client;
        delete state.failure;
        options.logger.info({ event: "mcp.host.ready", server: server.id }, "mcp server ready");
        return client;
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : "mcp_connect_failed";
        state.failure = { reason, at: now };
        // A tool listing is dropped with the connection, so a healed server is
        // re-listed rather than serving a catalog it can no longer honour.
        delete state.tools;
        options.logger.warn({ event: "mcp.host.unavailable", server: server.id, reason }, "mcp server down");
        throw new Error(reason);
      })
      .finally(() => {
        delete state.connecting;
      });
    state.connecting = attempt;
    return attempt;
  }

  async function toolsFor(server: McpServerSettings, now: number): Promise<readonly McpToolDescriptor[]> {
    const state = stateFor(server.id);
    if (state.tools !== undefined) return state.tools;
    const client = await connection(server, now);
    const initial = new Set(server.initialTools);
    const listed = await client.listTools();
    const projected = listed
      .filter((tool) => typeof tool.name === "string" && tool.name.length > 0)
      .map((tool) => ({
        server: server.id,
        name: tool.name,
        qualifiedName: `${server.id}_${tool.name}`,
        description:
          typeof tool.description === "string" && tool.description.length > 0
            ? tool.description.slice(0, MAX_DESCRIPTION_CHARACTERS)
            : tool.name,
        inputSchema:
          tool.inputSchema !== null && typeof tool.inputSchema === "object"
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: "object" },
        // No `initialTools` means all of them: right for a small server, and
        // the reason a large one should name the handful worth carrying.
        initial: initial.size === 0 || initial.has(tool.name),
      }));
    state.tools = projected;
    return projected;
  }

  return {
    async warm() {
      const now = Date.now();
      await Promise.all(
        (await activeServers(now)).map(async (server) => {
          try {
            await toolsFor(server, now);
          } catch {
            // Already logged by the connect path. Boot continues either way.
          }
        }),
      );
    },

    async catalog(lane) {
      const now = Date.now();
      const collected: McpToolDescriptor[] = [];
      for (const server of await activeServers(now)) {
        if (!laneAllows(server, lane)) continue;
        try {
          collected.push(...(await toolsFor(server, now)));
        } catch {
          // One unreachable server must not cost him the others. The failure is
          // already logged; the tools simply are not offered this session.
        }
      }
      return collected;
    },

    async call(input) {
      const now = Date.now();
      const server = (await activeServers(now)).find((entry) => entry.id === input.server);
      if (server === undefined) {
        return {
          outcome: "refused",
          reason: "unknown_server",
          detail: `no MCP server ${input.server} is connected`,
        };
      }
      // Re-checked rather than trusted from registration time: a session built
      // in one lane must not become a way to reach a console-only server.
      if (!laneAllows(server, input.lane)) {
        return {
          outcome: "refused",
          reason: "lane_denied",
          detail: `${server.id} stays at the console. Ask from the operator TUI, not from this room.`,
        };
      }
      try {
        const client = await connection(server, now);
        const result = await client.callTool(input.tool, input.arguments);
        options.logger.info(
          { event: "mcp.host.call", server: server.id, tool: input.tool },
          "mcp tool called",
        );
        return {
          outcome: "ok",
          content: result.content.slice(0, MAX_RESULT_CHARACTERS),
          isError: result.isError,
        };
      } catch (error) {
        // A call that fails may have killed the process; drop the connection so
        // the next attempt reconnects instead of writing to a closed pipe.
        const state = stateFor(server.id);
        delete state.connection;
        delete state.tools;
        return {
          outcome: "refused",
          reason: "server_unavailable",
          detail: error instanceof Error ? error.message.slice(0, 500) : "mcp_call_failed",
        };
      }
    },

    async close() {
      const closing = [...states.values()].map(async (state) => {
        try {
          await state.connection?.close();
        } catch {
          // Shutdown is best-effort; a server that already died is fine.
        }
      });
      states.clear();
      await Promise.all(closing);
    },
  };
}

/** Connects one configured server and adapts the SDK client to {@link McpConnection}. */
async function connectServer(
  server: McpServerSettings,
  credentials: CredentialStore,
): Promise<McpConnection> {
  const client = new Client({ name: "clankie", version: "1" }, { capabilities: {} });
  // The SDK's own transports do not satisfy its `Transport` interface under
  // `exactOptionalPropertyTypes` — their `onmessage` drops the generic and the
  // `extra` parameter the interface declares. The cast is at this one boundary
  // rather than loosening the repo's strictness for everyone.
  const transport = (await createTransport(server, credentials)) as unknown as Transport;
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  return {
    async listTools() {
      const collected: { name: string; description?: string | undefined; inputSchema?: unknown }[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? {} : { cursor }, {
          timeout: REQUEST_TIMEOUT_MS,
        });
        collected.push(...page.tools);
        const next =
          typeof page.nextCursor === "string" && page.nextCursor.length > 0 ? page.nextCursor : undefined;
        if (next !== undefined && seenCursors.has(next)) throw new Error("mcp_catalog_cursor_repeated");
        if (next !== undefined) seenCursors.add(next);
        cursor = next;
      } while (cursor !== undefined);
      return collected;
    },

    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: REQUEST_TIMEOUT_MS,
      });
      const blocks = Array.isArray(result.content) ? result.content : [];
      const text = blocks
        .filter(
          (block): block is { type: "text"; text: string } =>
            typeof block === "object" &&
            block !== null &&
            (block as { type?: unknown }).type === "text" &&
            typeof (block as { text?: unknown }).text === "string",
        )
        .map((block) => block.text)
        .join("\n");
      return { content: text, isError: result.isError === true };
    },

    close: () => client.close(),
  };
}

async function createTransport(
  server: McpServerSettings,
  credentials: CredentialStore,
): Promise<StdioClientTransport | StreamableHTTPClientTransport> {
  if (server.transport === "http") {
    if (server.url === undefined) throw new Error(`mcp server ${server.id} has no url`);
    const providerId = server.credential;
    return new StreamableHTTPClientTransport(new URL(server.url), {
      // The bearer is resolved per request, not captured at connect: an OAuth
      // token that expires mid-session is refreshed by the broker on the next
      // call rather than failing until someone restarts him.
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        if (providerId !== undefined) {
          const bearer = await resolveProviderBearer(providerId, credentials);
          if (bearer === undefined) {
            throw new Error(`${server.id} is not connected — run /connect ${server.id}`);
          }
          headers.set("authorization", `Bearer ${bearer}`);
        }
        return fetch(url, { ...init, headers });
      },
    });
  }

  if (server.command === undefined) throw new Error(`mcp server ${server.id} has no command`);
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LANG: process.env.LANG ?? "",
  };
  if (server.credential !== undefined && server.credentialEnv !== undefined) {
    const bearer = await resolveProviderBearer(server.credential, credentials);
    if (bearer === undefined) {
      throw new Error(`${server.id} needs credential ${server.credential}, which is not stored`);
    }
    environment[server.credentialEnv] = bearer;
  }
  return new StdioClientTransport({
    command: server.command,
    args: [...server.args],
    env: environment,
    // Servers chat on stderr; it must not land in the operator's console.
    stderr: "ignore",
  });
}
