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
 * - **Credentials.** Secrets stay broker-owned. Refresh happens before selecting
 *   a connection; each HTTP request checks the selected credential snapshot.
 *   Stdio receives that snapshot at spawn. Credential changes replace either
 *   transport instead of changing the account inside an existing MCP session.
 * - **Untrusted text.** A server's own tool descriptions become prompt text, so
 *   they are length-capped here rather than trusted to be reasonable.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  LINEAR_MCP_RESOURCE,
  ProviderAccountSchema,
  linearOauthNeedsRefresh,
  providerCredentialBearer,
  resolveProviderBearer,
  type CredentialStore,
  type ProviderCredential,
  type ProviderAccount,
} from "@clankie/credential-broker";
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

interface McpHostLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

/** One tool on one server, named as the captain will register it. */
interface McpToolDescriptor {
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

type McpRefusalReason = "unknown_server" | "lane_denied" | "server_unavailable";

type McpCallResult =
  | { readonly outcome: "ok"; readonly content: string; readonly isError: boolean }
  | { readonly outcome: "refused"; readonly reason: McpRefusalReason; readonly detail: string };

export interface McpHost {
  account(server: string, lane: CaptainSessionLaneV2): Promise<{ account: ProviderAccount; binding: string }>;
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
    readonly delegation?: { binding: string; grantId: string; principalId: string; workId: string };
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
const CURATED_MCP_SERVERS: readonly McpServerSettings[] = [
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
  /** Sees every settled call, for side channels that must know what he wrote. */
  readonly observeCall?: (call: {
    readonly server: string;
    readonly tool: string;
    readonly content: string;
    readonly isError: boolean;
    readonly account?: ProviderAccount;
    readonly worker?: { grantId: string; principalId: string; workId: string };
  }) => void;
}

/** The part of an MCP client this host uses, so tests can supply a fake. */
export interface McpConnection {
  listTools(): Promise<readonly { name: string; description?: string | undefined; inputSchema?: unknown }[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }>;
  close(): Promise<void>;
}

interface ServerState {
  readonly configuration: string;
  readonly credential: string;
  connection?: McpConnection;
  connecting?: Promise<McpConnection>;
  tools?: readonly McpToolDescriptor[];
  failure?: { reason: string; at: number };
}

/** Whether a server declared for `lane` may be reached from this room. */
function laneAllows(server: McpServerSettings, lane: CaptainSessionLaneV2): boolean {
  return server.lane === "everywhere" || lane === "operator";
}

function credentialDigest(credential: ProviderCredential): string {
  return createHash("sha256").update(JSON.stringify(credential)).digest("hex");
}

export function createMcpHost(options: McpHostOptions): McpHost {
  const connectImpl = options.connect ?? connectServer;
  const curated = options.curated ?? CURATED_MCP_SERVERS;
  const states = new Map<string, ServerState>();
  const missingCredentials = new Set<string>();
  const opening = new Set<Promise<McpConnection>>();
  let closed = false;

  /**
   * The servers in play right now: curated ones whose credential exists, plus
   * whatever the owner authored. Recomputed rather than fixed at boot so
   * connecting a service mid-session works without a restart, exactly as the
   * authored connector tools already did.
   *
   * Configuration is authority, so it is never cached. Transports and catalogs
   * remain cached while their configuration and selected credential match.
   */
  async function activeServers(): Promise<readonly McpServerSettings[]> {
    if (closed) throw new Error("MCP host is closed");
    const settings = await options.settings.load();
    // An explicitly disabled owner entry suppresses the curated default too.
    const authoredIds = new Set(settings.mcp.servers.map((server) => server.id));
    const servers = [
      ...curated.filter((server) => !authoredIds.has(server.id)),
      ...settings.mcp.servers,
    ].filter((server) => server.enabled);
    await Promise.all(
      [...states].map(async ([id, state]) => {
        const server = servers.find((entry) => entry.id === id);
        if (server === undefined || JSON.stringify(server) !== state.configuration) await retire(id, state);
      }),
    );
    return servers;
  }

  async function retire(id: string, state: ServerState): Promise<void> {
    if (states.get(id) === state) states.delete(id);
    // A pending connection checks its generation when it settles and closes
    // itself. Retiring it must not wait for a stalled initialize to finish.
    await state.connection?.close().catch(() => undefined);
  }

  async function credentialFingerprint(server: McpServerSettings, refresh = false): Promise<string> {
    if (server.credential === undefined) return "none";
    let stored = await options.credentials.get(server.credential);
    if (refresh && stored?.type === "oauth" && linearOauthNeedsRefresh(stored)) {
      await resolveProviderBearer(server.credential, options.credentials);
      stored = await options.credentials.get(server.credential);
    }
    if (stored === undefined) {
      const state = states.get(server.id);
      if (state !== undefined) await retire(server.id, state);
      if (!missingCredentials.has(server.id)) {
        missingCredentials.add(server.id);
        options.logger.warn(
          { event: "mcp.host.credential_missing", server: server.id, credential: server.credential },
          "mcp server hidden: no stored credential",
        );
      }
      throw new Error(`${server.id} needs stored credential ${server.credential}`);
    }
    if (missingCredentials.delete(server.id)) {
      options.logger.info(
        { event: "mcp.host.credential_restored", server: server.id, credential: server.credential },
        "mcp server credential restored",
      );
    }
    return credentialDigest(stored);
  }

  async function stateFor(server: McpServerSettings): Promise<ServerState> {
    let credential: string;
    try {
      credential = await credentialFingerprint(server, true);
    } catch (error) {
      const previous = states.get(server.id);
      if (previous !== undefined) await retire(server.id, previous);
      throw error;
    }
    if (closed) throw new Error("MCP host is closed");
    const configuration = JSON.stringify(server);
    const existing = states.get(server.id);
    if (existing?.configuration === configuration && existing.credential === credential) return existing;
    const created: ServerState = { configuration, credential };
    // Publish the new generation before closing the old one; concurrent callers
    // must not replace each other's pending connection during that await.
    states.set(server.id, created);
    if (existing !== undefined) await retire(server.id, existing);
    return created;
  }

  async function assertCurrent(server: McpServerSettings, state: ServerState): Promise<void> {
    const selected = (await activeServers()).find((entry) => entry.id === server.id);
    if (
      selected === undefined ||
      JSON.stringify(selected) !== state.configuration ||
      (await credentialFingerprint(selected)) !== state.credential ||
      states.get(server.id) !== state ||
      closed
    ) {
      await retire(server.id, state);
      throw new Error(`${server.id} connection changed; inspect current configuration before retrying`);
    }
  }

  async function connection(
    server: McpServerSettings,
    state: ServerState,
    now: number,
  ): Promise<McpConnection> {
    if (state.connection !== undefined) return state.connection;
    if (state.connecting !== undefined) return state.connecting;
    if (state.failure !== undefined && now - state.failure.at < FAILURE_COOLDOWN_MS) {
      throw new Error(state.failure.reason);
    }
    const attempt = connectImpl(server, options.credentials, state.credential)
      .then(async (client) => {
        if (closed || states.get(server.id) !== state) {
          await client.close().catch(() => undefined);
          throw new Error(`${server.id} connection superseded`);
        }
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
        opening.delete(attempt);
      });
    state.connecting = attempt;
    opening.add(attempt);
    return attempt;
  }

  async function toolsFor(server: McpServerSettings, now: number): Promise<readonly McpToolDescriptor[]> {
    const state = await stateFor(server);
    if (state.tools !== undefined) {
      await assertCurrent(server, state);
      return state.tools;
    }
    const client = await connection(server, state, now);
    const initial = new Set(server.initialTools);
    const listed = await client.listTools();
    await assertCurrent(server, state);
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

  async function account(server: McpServerSettings, expectedCredential?: string) {
    const stored =
      server.credential === undefined ? undefined : await options.credentials.get(server.credential);
    if (stored === undefined || !("account" in stored) || stored.account === undefined)
      throw new Error(`${server.id} has no verified connected account`);
    if (expectedCredential !== undefined && credentialDigest(stored) !== expectedCredential)
      throw new Error(`${server.id} credential changed`);
    return {
      account: stored.account,
      binding: createHash("sha256")
        .update(
          JSON.stringify([
            server,
            stored.account.connectionId,
            stored.account.provider,
            stored.account.userId,
            stored.account.workspaceId,
          ]),
        )
        .digest("hex"),
    };
  }

  return {
    async account(id, lane) {
      const server = (await activeServers()).find((entry) => entry.id === id);
      if (server === undefined || !laneAllows(server, lane))
        throw new Error("Connected account unavailable in this lane");
      return account(server);
    },
    async warm() {
      const now = Date.now();
      await Promise.all(
        (await activeServers()).map(async (server) => {
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
      for (const server of await activeServers()) {
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
      const server = (await activeServers()).find((entry) => entry.id === input.server);
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
      let state: ServerState | undefined;
      try {
        state = await stateFor(server);
        const client = await connection(server, state, now);
        const connectedAccount =
          input.delegation !== undefined || options.observeCall !== undefined
            ? await account(server, state.credential).catch((error: unknown) => {
                if (input.delegation !== undefined) throw error;
                return undefined;
              })
            : undefined;
        if (input.delegation !== undefined && connectedAccount?.binding !== input.delegation.binding)
          throw new Error("Delegated account binding changed; a new grant is required");
        await assertCurrent(server, state);
        const result = await client.callTool(input.tool, input.arguments);
        options.logger.info(
          {
            event: "mcp.host.call",
            server: server.id,
            tool: input.tool,
            ...(input.delegation === undefined
              ? {}
              : {
                  worker: {
                    grantId: input.delegation.grantId,
                    principalId: input.delegation.principalId,
                    workId: input.delegation.workId,
                  },
                }),
          },
          "mcp tool called",
        );
        try {
          options.observeCall?.({
            server: server.id,
            tool: input.tool,
            content: result.content,
            isError: result.isError,
            ...(connectedAccount === undefined ? {} : { account: connectedAccount.account }),
            ...(input.delegation === undefined
              ? {}
              : {
                  worker: {
                    grantId: input.delegation.grantId,
                    principalId: input.delegation.principalId,
                    workId: input.delegation.workId,
                  },
                }),
          });
        } catch {
          // The provider already settled. A receipt failure must not invite a duplicate write.
          options.logger.warn(
            { event: "mcp.host.observer_failed", server: server.id, tool: input.tool },
            "MCP call settled but its receipt could not be recorded",
          );
        }
        return {
          outcome: "ok",
          content: result.content.slice(0, MAX_RESULT_CHARACTERS),
          isError: result.isError,
        };
      } catch (error) {
        // A call that fails may have killed the process; drop the connection so
        // the next attempt reconnects instead of writing to a closed pipe.
        if (state !== undefined && state.failure === undefined) await retire(server.id, state);
        return {
          outcome: "refused",
          reason: "server_unavailable",
          detail: error instanceof Error ? error.message.slice(0, 500) : "mcp_call_failed",
        };
      }
    },

    async close() {
      closed = true;
      await Promise.all([...states].map(([id, state]) => retire(id, state)));
      await Promise.allSettled(opening);
    },
  };
}

/** Verify one locked credential snapshot at its OAuth audience, independent of owner-authored servers. */
export async function verifyLinearMcpAccount(
  credential: Extract<ProviderCredential, { type: "oauth" }>,
): Promise<ProviderAccount> {
  const client = await connectServer(
    {
      id: "linear",
      transport: "http",
      url: LINEAR_MCP_RESOURCE,
      credential: "linear",
      args: [],
      lane: "operator",
      initialTools: [],
      enabled: true,
    },
    { get: async () => credential },
    credentialDigest(credential),
  );
  try {
    const read = async (tool: string, args: Record<string, unknown>) => {
      const result = await client.callTool(tool, args);
      if (result.isError) throw new Error(`Linear identity verification failed: ${tool}`);
      return JSON.parse(result.content) as unknown;
    };
    const identity = z.object({ id: z.string().uuid(), name: z.string().min(1) });
    const user = identity
      .extend({ email: z.string().email() })
      .parse(await read("get_user", { query: "me" }));
    const workspace = identity.parse(await read("get_workspace", {}));
    return ProviderAccountSchema.parse({
      provider: "linear",
      connectionId: randomUUID(),
      verifiedAt: new Date().toISOString(),
      userId: user.id,
      email: user.email,
      name: user.name,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Connects one configured server and adapts the SDK client to {@link McpConnection}. */
async function connectServer(
  server: McpServerSettings,
  credentials: Pick<CredentialStore, "get">,
  expectedCredential: string,
): Promise<McpConnection> {
  const client = new Client({ name: "clankie", version: "1" }, { capabilities: {} });
  // The SDK's own transports do not satisfy its `Transport` interface under
  // `exactOptionalPropertyTypes` — their `onmessage` drops the generic and the
  // `extra` parameter the interface declares. The cast is at this one boundary
  // rather than loosening the repo's strictness for everyone.
  const transport = (await createTransport(server, credentials, expectedCredential)) as unknown as Transport;
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
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
  credentials: Pick<CredentialStore, "get">,
  expectedCredential: string,
): Promise<StdioClientTransport | StreamableHTTPClientTransport> {
  const selectedBearer = async (): Promise<string> => {
    const stored = server.credential === undefined ? undefined : await credentials.get(server.credential);
    if (stored === undefined || credentialDigest(stored) !== expectedCredential) {
      throw new Error(`${server.id} credential changed; reconnect before calling tools`);
    }
    if (stored.type === "oauth" && stored.expires !== 0 && stored.expires <= Date.now()) {
      throw new Error(`${server.id} credential expired; reconnect to refresh`);
    }
    const bearer = providerCredentialBearer(stored);
    if (bearer === undefined) throw new Error(`${server.id} has no usable stored credential`);
    return bearer;
  };
  if (server.transport === "http") {
    if (server.url === undefined) throw new Error(`mcp server ${server.id} has no url`);
    const providerId = server.credential;
    return new StreamableHTTPClientTransport(new URL(server.url), {
      // Validate the selected credential on every wire request. A live MCP
      // session must never adopt a replacement account halfway through a call.
      // Logical calls refresh before connection selection; changed credentials
      // establish a fresh transport, without replaying an uncertain tool call.
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        if (providerId !== undefined) {
          headers.set("authorization", `Bearer ${await selectedBearer()}`);
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
    environment[server.credentialEnv] = await selectedBearer();
  }
  return new StdioClientTransport({
    command: server.command,
    args: [...server.args],
    env: environment,
    // Servers chat on stderr; it must not land in the operator's console.
    stderr: "ignore",
  });
}
