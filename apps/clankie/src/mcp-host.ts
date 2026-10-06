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
import {
  captureConversationAuthority,
  captureNativeSeatAuthority,
  type ConversationAuthority,
  type ConversationOwner,
  type LinearRecipient,
  type WorkerWriteAuthority,
} from "./captain/conversation-owner.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  LINEAR_MCP_RESOURCE,
  LINEAR_API_PROVIDER_ID,
  ProviderAccountSchema,
  linearOauthNeedsRefresh,
  providerCredentialBearer,
  resolveProviderBearer,
  GOOGLE_ACCOUNT_DEFINITIONS,
  GOOGLE_PROVIDER_IDS,
  googleCredentialMetadata,
  googleCredentialUsable,
  googlePickedFileIds,
  googleIdentityEpoch,
  googleAppSecret,
  normalizeProviderId,
  GOOGLE_OAUTH_APP_PROVIDER_ID,
  resolveGoogleBearer,
  type GoogleOAuthApp,
  type GoogleOAuthEndpoints,
  type CredentialStore,
  type ProviderCredential,
  type ProviderAccount,
} from "@clankie/credential-broker";
import type { CaptainSessionLaneV2 } from "@clankie/protocol";
import { GoogleAccountProviderSchema, type GoogleAccountProvider } from "@clankie/protocol/accounts";
import type { McpServerSettings, SettingsStore } from "@clankie/settings";
import { isLinearWorkerTool, LINEAR_WORKER_TOOLS, publishLinearWorker } from "./linear-publishing.ts";
import { compactLinearWrite } from "./linear-write-receipt.ts";
import type { ProjectProcessProof } from "./project-process-proof.ts";
import { mcpToolSchemaError } from "./mcp-tool-schema.ts";
import { TRACKER_TOOLS, type TrackerToolBackend } from "@clankie/work-items";
import { createPrioritySortedLinearIssueReader, callCachedLinearCollection } from "./tracker-tool-router.ts";

/** Matches the browser host's ceiling; pi truncates again on the way out. */
const MAX_RESULT_CHARACTERS = 50_000;
/** Data consumers need intact text, with a separate byte ceiling instead of truncation. */
const MAX_DATA_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_DESCRIPTION_CHARACTERS = 4_000;
const CONNECT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** Publication attribution is optional; it cannot exhaust a connected-account call's budget. */
const ATTRIBUTION_TIMEOUT_MS = 2_000;
const isReadTool = (name: string) => /^(?:get|list|search|check|fetch|read)_/u.test(name);
/** Per invocation, including the SDK's later credential/header awaits; never connection-global. */
const dispatchFence = new AsyncLocalStorage<(() => void) | undefined>();
/** Refusal before a wire effect does not mean the shared provider connection failed. */
class DispatchRefused extends Error {}
/**
 * How long a failed connection is remembered before the next call retries.
 *
 * Without it a dead stdio server is respawned on every tool call, which turns a
 * typo in `command` into a process storm. Without an expiry at all, an owner
 * who fixes the typo would have to restart the service to be believed.
 */
const FAILURE_COOLDOWN_MS = 60_000;
const LOCAL_TRACKER_COMMAND = "clankie:local-tracker";
const API_TRACKER_COMMAND = "clankie:linear-api-tracker";
/** A server alias cannot widen the policy attached to its managed broker grant. */
const googleProvider = (
  server: Pick<McpServerSettings, "id" | "credential">,
): GoogleAccountProvider | undefined => {
  let providerId: string | undefined;
  try {
    providerId = server.credential === undefined ? undefined : normalizeProviderId(server.credential);
  } catch {
    // An invalid authored reference fails in its own credential admission;
    // classification must not hide unrelated connected servers.
  }
  const binding = GoogleAccountProviderSchema.safeParse(providerId);
  if (binding.success) return binding.data;
  const named = GoogleAccountProviderSchema.safeParse(server.id);
  return named.success ? named.data : undefined;
};
function assertGoogleCredentialBinding(
  server: Pick<McpServerSettings, "id" | "credential">,
  credential: ProviderCredential | undefined,
): GoogleAccountProvider | undefined {
  const google = googleProvider(server);
  if (
    (credential?.type === "oauth" && credential.googleAuth === "user" && google === undefined) ||
    (google !== undefined &&
      (server.credential === undefined || normalizeProviderId(server.credential) !== google))
  )
    throw new Error("Google access requires an unambiguous managed provider credential binding");
  return google;
}

interface TrackerBackendStatus {
  readonly backend: "linear" | "local";
  readonly reason: "owner_connected" | "linear_disconnected" | "linear_disabled";
  readonly binding: string;
}

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

type McpRefusalReason =
  | "unknown_server"
  | "lane_denied"
  | "server_unavailable"
  | "result_too_large"
  | "body_owned";

/** In-process service capability; HTTP/model arguments can never construct this symbol. */
export const MINECRAFT_BODY_ACCESS = Symbol("minecraft-body-access");

type McpCallResult =
  | { readonly outcome: "ok"; readonly content: string; readonly isError: boolean }
  | {
      readonly outcome: "refused";
      readonly reason: McpRefusalReason;
      readonly detail: string;
      readonly possiblyDispatched?: boolean;
    };

export interface McpHost {
  account(server: string, lane: CaptainSessionLaneV2): Promise<{ account: ProviderAccount; binding: string }>;
  /** A local tracker has a resource binding, never a fabricated provider account. */
  binding?(
    server: string,
    lane: CaptainSessionLaneV2,
  ): Promise<{
    account?: ProviderAccount;
    binding: string;
    backend?: "local";
  }>;
  trackerStatus?(): Promise<TrackerBackendStatus>;
  /** A verified provider change retires cached lists, including self-echo webhooks. */
  invalidateTrackerReads?(): void;
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
    /** Internal data consumers only; model-facing calls retain the default 50k character cap. */
    readonly resultMode?: "model" | "data";
    /** Total caller budget, including setup; never a model tool argument. */
    readonly timeoutMs?: number;
    /** Only MinecraftMcpPort holds Clankie's motor; raw and delegated routes are denied. */
    readonly bodyAccess?: typeof MINECRAFT_BODY_ACCESS;
    readonly delegation?: { binding: string; grantId: string; principalId: string; workId: string };
    /** Async admission may return a synchronous revocation check run after the final host reads. */
    readonly fence?: () => Promise<void | (() => void)>;
    /** Host-stamped turn attribution; it grants no provider tools. */
    readonly conversationAuthority?: ConversationAuthority;
    /** Host-only socket/controller proof for native author attribution; never a grant. */
    readonly nativeWriteProof?: (signal?: AbortSignal) => Promise<ProjectProcessProof | undefined>;
    /** Internal receipt hooks; never caller/model arguments. */
    readonly onDispatch?: () => void;
    /** Confirmed response in the caller's result mode; may follow a caller timeout. */
    readonly onSettled?: (
      result: { content: string; isError: boolean },
      observation?: { readonly readOnly: true },
    ) => void;
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
    // `mcp_tool_search` away. Names must match the live server: it writes
    // through `save_*` upserts, not `create_*`/`update_*`.
    initialTools: [
      "list_issues",
      "get_issue",
      "save_issue",
      "list_comments",
      "save_comment",
      "list_teams",
      "list_projects",
    ],
    enabled: true,
  },
  ...GOOGLE_PROVIDER_IDS.map(
    (provider): McpServerSettings => ({
      id: provider,
      transport: "http",
      url: GOOGLE_ACCOUNT_DEFINITIONS[provider].url,
      args: [],
      lane: "operator",
      credential: provider,
      initialTools: [...GOOGLE_ACCOUNT_DEFINITIONS[provider].tools],
      enabled: true,
    }),
  ),
];

export interface McpHostOptions {
  /** The same body-owned developer app as /v1/accounts; no secret leaves the broker. */
  readonly googleApps?: () => Promise<GoogleOAuthApp>;
  readonly googleFetch?: typeof fetch;
  readonly googleEndpoints?: GoogleOAuthEndpoints;
  /** The durable fallback. Connected transport failures never select this backend. */
  readonly localTracker?: TrackerToolBackend;
  /** Registered GraphQL OAuth, with a separate broker audience from MCP. */
  readonly linearApiTracker?: TrackerToolBackend;
  readonly trackerIdentity?: string;
  /** Internal clock for list freshness; never a caller/model argument. */
  readonly trackerReadClock?: () => number;
  /** Read-only lookup in already registered stores; never enrolls a repository. */
  readonly trackerRepoForCall?: (name: string, args: Record<string, unknown>) => Promise<string | undefined>;
  /** Repository conventions are backends of the same public tracker vocabulary. */
  readonly trackerForRepo?: (input: {
    name: string;
    args: Record<string, unknown>;
    repo: string;
    lane: CaptainSessionLaneV2;
    /** Only the native owner operator, never a delegated worker, may enroll paths. */
    local: boolean;
    beforeWrite(): Promise<void>;
    onDispatch(): void;
    effectConfirmed(): void;
  }) => Promise<unknown>;
  /** Shipped lazy motor, reserved for the service's MinecraftPort rather than raw catalogs. */
  readonly minecraftMotor?: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd?: string;
  };
  readonly credentials: CredentialStore;
  readonly settings: SettingsStore;
  readonly logger: McpHostLogger;
  /** Overrides the curated list in tests so no suite reaches the network. */
  readonly curated?: readonly McpServerSettings[];
  /** Injected in tests; the real one connects a transport. */
  readonly connect?: (server: McpServerSettings, credentials: CredentialStore) => Promise<McpConnection>;
  readonly linearAuthor?: (personaId: string) => Promise<{ name: string; avatarUrl: string } | undefined>;
  /** Test seam for the two app-attributed GraphQL mutations. */
  readonly linearFetch?: typeof fetch;
  /** Sees every settled call, for side channels that must know what he wrote. */
  readonly conversationForWorker?: (principalId: string) => Promise<ConversationAuthority | undefined>;
  /** Fresh author/owner proof captured at call entry, before connected-provider awaits. */
  readonly writeAuthorityForWorker?: (
    principalId: string,
    nativeWriteProof?: (signal?: AbortSignal) => Promise<ProjectProcessProof | undefined>,
  ) => Promise<WorkerWriteAuthority | undefined>;
  readonly observeCall?: (call: {
    readonly server: string;
    readonly tool: string;
    readonly content: string;
    readonly arguments: Record<string, unknown>;
    readonly owner?: ConversationOwner;
    readonly recipient?: LinearRecipient;
    readonly isError: boolean;
    readonly account?: ProviderAccount;
    readonly worker?: { grantId: string; principalId: string; workId: string };
  }) => unknown;
}

/** The part of an MCP client this host uses, so tests can supply a fake. */
export interface McpConnection {
  /** The transport rechecks admission at its actual HTTP/stdin send boundary. */
  readonly dispatchesAtWire?: boolean;
  listTools(): Promise<readonly { name: string; description?: string | undefined; inputSchema?: unknown }[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{ content: string; isError: boolean }>;
  close(): Promise<void>;
}

interface ServerState {
  readonly configuration: string;
  readonly credential: string;
  activeCalls: number;
  retired?: boolean;
  closing?: Promise<void>;
  connection?: McpConnection;
  connecting?: Promise<McpConnection>;
  tools?: readonly McpToolDescriptor[];
  nativeToolNames?: ReadonlySet<string>;
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
  const googleApps =
    options.googleApps ?? (async () => (await options.settings.load()).oauthApps?.google ?? {});
  const connectImpl = options.connect ?? connectServer;
  const curated = options.curated ?? CURATED_MCP_SERVERS;
  const states = new Map<string, ServerState>();
  const retired = new Set<ServerState>();
  const missingCredentials = new Set<string>();
  const opening = new Set<Promise<McpConnection>>();
  const trackerReads = createPrioritySortedLinearIssueReader(
    options.trackerReadClock === undefined ? {} : { clock: options.trackerReadClock },
  );
  let closed = false;
  const isLocalTracker = (server: McpServerSettings) =>
    server.id === "linear" && server.command === LOCAL_TRACKER_COMMAND;
  const isApiTracker = (server: McpServerSettings) =>
    server.id === "linear" && server.command === API_TRACKER_COMMAND;
  const trackerCatalog = (options.localTracker ?? options.linearApiTracker)?.catalog() ?? [];
  const trackerNames = new Set(trackerCatalog.map((tool) => tool.name));
  const localBinding = createHash("sha256")
    .update(JSON.stringify(["local-tracker", options.trackerIdentity ?? "service-tracker"]))
    .digest("hex");
  const canonicalTrackerCatalog = (): McpToolDescriptor[] =>
    trackerCatalog.map((tool) => ({
      ...tool,
      server: "linear",
      qualifiedName: `linear_${tool.name}`,
      initial: CURATED_MCP_SERVERS[0]!.initialTools.includes(tool.name),
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...(tool.inputSchema as { properties?: Record<string, unknown> }).properties,
          repo: {
            type: "string",
            description:
              "Optional registered repository or absolute path (operator tools only); follows its saved tracker convention.",
          },
        },
      },
    }));

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
    const minecraft = options.minecraftMotor;
    let servers = [
      ...curated.filter((server) => !authoredIds.has(server.id)),
      ...settings.mcp.servers.filter((server) => minecraft === undefined || server.id !== "minecraft"),
      ...(minecraft === undefined
        ? []
        : [
            {
              id: "minecraft",
              transport: "stdio" as const,
              command: minecraft.command,
              args: [...minecraft.args],
              ...(minecraft.cwd === undefined ? {} : { cwd: minecraft.cwd }),
              lane: "operator" as const,
              initialTools: [],
              enabled: true,
            },
          ]),
    ]
      .filter((server) => server.enabled)
      .map((server) =>
        googleProvider(server) === undefined ? server : { ...server, lane: "operator" as const },
      );
    const linear = servers.find((server) => server.id === "linear");
    if (linear && options.linearApiTracker && (await options.credentials.get(LINEAR_API_PROVIDER_ID))) {
      servers = servers.map((server) =>
        server.id !== "linear"
          ? server
          : {
              ...server,
              transport: "stdio" as const,
              command: API_TRACKER_COMMAND,
              args: [],
              url: undefined,
              credential: LINEAR_API_PROVIDER_ID,
            },
      );
    }
    if (options.localTracker) {
      const linear = servers.find((server) => server.id === "linear");
      const connected =
        linear !== undefined &&
        (linear.credential === undefined || (await options.credentials.get(linear.credential)) !== undefined);
      if (!connected) {
        servers = [
          ...servers.filter((server) => server.id !== "linear"),
          {
            id: "linear",
            transport: "stdio",
            command: LOCAL_TRACKER_COMMAND,
            args: [],
            lane: "everywhere",
            initialTools: CURATED_MCP_SERVERS[0]!.initialTools,
            enabled: true,
          },
        ];
      }
    }
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
    if (!state.retired) {
      if (id === "linear") trackerReads.invalidate();
      state.retired = true;
      retired.add(state);
    }
    // A pending connection checks its generation when it settles and closes
    // itself. Retiring it must not wait for a stalled initialize to finish.
    await closeRetired(state);
  }

  function closeRetired(state: ServerState): Promise<void> {
    if (!state.retired || (state.activeCalls > 0 && !closed)) return Promise.resolve();
    return (state.closing ??= (async () => {
      await state.connection?.close().catch(() => undefined);
      retired.delete(state);
    })());
  }

  async function credentialFingerprint(server: McpServerSettings, refresh = false): Promise<string> {
    if (server.credential === undefined) return "none";
    let stored = await options.credentials.get(server.credential);
    const google = assertGoogleCredentialBinding(server, stored);
    if (google !== undefined) {
      const apps = await googleApps();
      if (refresh) {
        await resolveGoogleBearer({
          store: options.credentials,
          provider: google,
          apps: () => Promise.resolve(apps),
          ...(options.googleFetch === undefined ? {} : { fetchImpl: options.googleFetch }),
          ...(options.googleEndpoints === undefined ? {} : { endpoints: options.googleEndpoints }),
        });
        stored = await options.credentials.get(server.credential);
      }
      if (!apps.clientId || !googleCredentialUsable(stored, google, apps.clientId))
        throw new Error("Google access requires reconnecting");
    }
    if (stored?.type === "oauth" && stored.linearAuth === "api" && !isApiTracker(server))
      throw new Error("Registered Linear API credentials cannot authenticate MCP");
    if (refresh && stored?.type === "oauth" && linearOauthNeedsRefresh(stored)) {
      await resolveProviderBearer(
        server.credential,
        options.credentials,
        Date.now(),
        options.linearFetch ? { fetch: options.linearFetch } : {},
      );
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
    const created: ServerState = { configuration, credential, activeCalls: 0 };
    if (server.id === "linear") trackerReads.invalidate();
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
    const localConnection: McpConnection = {
      listTools: async () => trackerCatalog,
      callTool: async (name, args) => {
        try {
          return {
            content: JSON.stringify(
              await (isApiTracker(server) ? options.linearApiTracker! : options.localTracker!).call(
                name,
                args,
              ),
            ),
            isError: false,
          };
        } catch (error) {
          return {
            content: JSON.stringify({
              error: "tracker_request_failed",
              detail: error instanceof Error ? error.message : String(error),
            }),
            isError: true,
          };
        }
      },
      close: async () => undefined,
    };
    const attempt = (
      isLocalTracker(server) || isApiTracker(server)
        ? Promise.resolve(localConnection)
        : connectImpl(server, options.credentials, state.credential)
    )
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
    const pickedFiles =
      googleProvider(server) === "google-drive"
        ? googlePickedFileIds(await options.credentials.get(server.credential!))
        : undefined;
    const initial = new Set(server.initialTools);
    const listed = await client.listTools();
    await assertCurrent(server, state);
    state.nativeToolNames = new Set(listed.map((tool) => tool.name));
    // The canonical subset retains identical schemas even when the owner connects
    // Linear mid-session. The rest of Linear's native catalog remains discoverable.
    const exposed = isApiTracker(server)
      ? options.linearApiTracker!.catalog()
      : server.id === "linear" && (options.localTracker || options.linearApiTracker)
        ? [...listed.filter((tool) => !trackerNames.has(tool.name)), ...trackerCatalog]
        : listed;
    const projected = exposed
      .filter((tool) => {
        const google = googleProvider(server);
        return (
          google === undefined ||
          (GOOGLE_ACCOUNT_DEFINITIONS[google].tools as readonly string[]).includes(tool.name)
        );
      })
      .filter((tool) => {
        const reason = mcpToolSchemaError(tool);
        if (reason === undefined) return true;
        options.logger.warn(
          { event: "mcp.host.tool_rejected", server: server.id, tool: tool.name, reason },
          "mcp tool omitted: incompatible with native clients",
        );
        return false;
      })
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
            ? pickedFiles !== undefined
              ? {
                  ...(tool.inputSchema as Record<string, unknown>),
                  properties: {
                    ...(tool.inputSchema as { properties?: Record<string, unknown> }).properties,
                    fileId: { type: "string", enum: pickedFiles },
                  },
                  required: [
                    ...new Set([
                      ...(Array.isArray((tool.inputSchema as { required?: unknown }).required)
                        ? (tool.inputSchema as { required: string[] }).required
                        : []),
                      "fileId",
                    ]),
                  ],
                }
              : server.id === "linear" && trackerNames.has(tool.name)
                ? {
                    ...(tool.inputSchema as Record<string, unknown>),
                    properties: {
                      ...(tool.inputSchema as { properties?: Record<string, unknown> }).properties,
                      repo: {
                        type: "string",
                        description:
                          "Optional registered repository or absolute path (operator tools only); follows its saved tracker convention.",
                      },
                    },
                  }
                : (tool.inputSchema as Record<string, unknown>)
            : { type: "object" },
        // No `initialTools` means all of them: right for a small server, and
        // the reason a large one should name the handful worth carrying.
        initial: initial.size === 0 || initial.has(tool.name),
      }));
    // A renamed upstream tool silently drops out of the listed set otherwise.
    const missing = [...initial].filter((name) => !projected.some((tool) => tool.name === name));
    if (missing.length > 0) {
      options.logger.warn(
        { event: "mcp.host.initial_tools_missing", server: server.id, missing },
        "mcp server no longer offers some initial tools",
      );
    }
    const credential =
      server.id === "linear" && server.credential !== undefined
        ? await options.credentials.get(server.credential)
        : undefined;
    if (
      credential?.type === "oauth" &&
      (credential.linearAuth === "app" || credential.linearAuth === "api") &&
      credential.account?.actor === "app" &&
      options.linearAuthor
    ) {
      projected.push(
        ...LINEAR_WORKER_TOOLS.map((tool) => ({
          ...tool,
          server: "linear",
          qualifiedName: `linear_${tool.name}`,
          initial: true,
        })),
      );
    }
    state.tools = projected;
    return projected;
  }

  async function account(server: McpServerSettings, expectedCredential?: string) {
    if (isLocalTracker(server)) return { binding: localBinding, backend: "local" as const };
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
    invalidateTrackerReads: () => trackerReads.invalidate(),
    async account(id, lane) {
      const server = (await activeServers()).find((entry) => entry.id === id);
      if (server === undefined || !laneAllows(server, lane))
        throw new Error("Connected account unavailable in this lane");
      const selected = await account(server);
      if (selected.account === undefined)
        throw new Error(`${id} is using the local tracker, not a connected account`);
      return { account: selected.account, binding: selected.binding };
    },
    async binding(id, lane) {
      const server = (await activeServers()).find((entry) => entry.id === id);
      if (server === undefined || !laneAllows(server, lane))
        throw new Error("Tool resource unavailable in this lane");
      return account(server);
    },
    async trackerStatus() {
      const server = (await activeServers()).find((entry) => entry.id === "linear");
      if (!server) throw new Error("Tracker is unavailable");
      if (!isLocalTracker(server))
        return {
          backend: "linear",
          reason: "owner_connected",
          // Backend discovery does not acquire a verified account grant.
          binding:
            (await account(server).catch(() => undefined))?.binding ??
            createHash("sha256")
              .update(JSON.stringify([server, await credentialFingerprint(server)]))
              .digest("hex"),
        };
      const authored = (await options.settings.load()).mcp.servers.find((entry) => entry.id === "linear");
      return {
        backend: "local",
        reason: authored?.enabled === false ? "linear_disabled" : "linear_disconnected",
        binding: localBinding,
      };
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
        if (server.id === "minecraft") continue;
        if (!laneAllows(server, lane)) continue;
        try {
          collected.push(...(await toolsFor(server, now)));
        } catch {
          // One unreachable server must not cost him the others. The failure is
          // already logged; the tools simply are not offered this session.
          if (server.id === "linear" && (options.localTracker || options.linearApiTracker))
            collected.push(...canonicalTrackerCatalog());
        }
      }
      return collected;
    },

    async call(input) {
      if (
        input.server === "minecraft" &&
        (input.bodyAccess !== MINECRAFT_BODY_ACCESS || input.delegation !== undefined)
      )
        return {
          outcome: "refused",
          reason: "body_owned",
          detail: "Clankie's Minecraft body is reachable only through the Minecraft service tools.",
        };
      input = { ...input, arguments: structuredClone(input.arguments) };
      const timeoutMs =
        input.timeoutMs === undefined
          ? REQUEST_TIMEOUT_MS
          : z.number().int().positive().max(1_200_000).parse(input.timeoutMs);
      const signal = AbortSignal.timeout(timeoutMs);
      const deadline = Date.now() + timeoutMs;
      const attributionAbort = new AbortController();
      let attributionRemainingMs = Math.min(ATTRIBUTION_TIMEOUT_MS, timeoutMs / 4);
      const optionalAttribution = async <T>(task: () => Promise<T>): Promise<T | undefined> => {
        const remaining = Math.min(attributionRemainingMs, deadline - Date.now());
        if (remaining <= 0 || signal.aborted || attributionAbort.signal.aborted) return undefined;
        const started = Date.now();
        const admission = AbortSignal.any([signal, attributionAbort.signal]);
        let aborted!: () => void;
        const timer = setTimeout(
          () => attributionAbort.abort(new Error("Optional MCP publication attribution timed out")),
          remaining,
        );
        try {
          return await Promise.race([
            Promise.resolve()
              .then(task)
              .catch(() => undefined),
            new Promise<undefined>((resolve) => {
              aborted = () => resolve(undefined);
              admission.addEventListener("abort", aborted, { once: true });
              if (admission.aborted) aborted();
            }),
          ]);
        } finally {
          clearTimeout(timer);
          admission.removeEventListener("abort", aborted);
          attributionRemainingMs -= Date.now() - started;
        }
      };
      // Every later author reproof uses this same bounded capability, including
      // callbacks retained by the captain. Expiry cancels queued native work.
      const nativeWriteProof = input.nativeWriteProof
        ? async (requested?: AbortSignal) => {
            const proofSignal = AbortSignal.any([
              signal,
              attributionAbort.signal,
              ...(requested ? [requested] : []),
            ]);
            proofSignal.throwIfAborted();
            return input.nativeWriteProof!(proofSignal);
          }
        : undefined;
      let dispatched = false;
      const perform = async (): Promise<McpCallResult> => {
        // Read discovery never needs a publishing author. This classification
        // only controls optional attribution; fleet/account admission is unchanged.
        const publicationCall = !isReadTool(input.tool);
        const providedSource =
          publicationCall && input.conversationAuthority
            ? captureConversationAuthority(input.conversationAuthority)
            : undefined;
        const workerProof =
          publicationCall && input.delegation && options.writeAuthorityForWorker
            ? await optionalAttribution(() =>
                options.writeAuthorityForWorker!(input.delegation!.principalId, nativeWriteProof),
              )
            : undefined;
        const workerSource =
          workerProof?.conversationAuthority ??
          (publicationCall && !providedSource && input.delegation && !options.writeAuthorityForWorker
            ? await optionalAttribution(async () =>
                options.conversationForWorker?.(input.delegation!.principalId),
              )
            : undefined);
        const admittedSource =
          providedSource ?? (workerSource ? captureConversationAuthority(workerSource) : undefined);
        const admittedNativeSource = workerProof?.nativeRecipientAuthority
          ? captureNativeSeatAuthority(workerProof.nativeRecipientAuthority)
          : undefined;
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
        const google = googleProvider(server);
        if (
          google !== undefined &&
          (input.delegation !== undefined ||
            !(GOOGLE_ACCOUNT_DEFINITIONS[google].tools as readonly string[]).includes(input.tool))
        ) {
          return {
            outcome: "refused",
            reason: "lane_denied",
            possiblyDispatched: false,
            detail: "This Google connection permits only its owner's read-only tools.",
          };
        }
        let trackerRepo = input.arguments.repo;
        let inferredRepo = false;
        if (
          isLocalTracker(server) &&
          trackerNames.has(input.tool) &&
          trackerRepo === undefined &&
          input.lane === "operator" &&
          options.trackerRepoForCall
        ) {
          try {
            trackerRepo = await options.trackerRepoForCall(input.tool, input.arguments);
            inferredRepo = trackerRepo !== undefined;
          } catch (error) {
            return {
              outcome: "refused",
              reason: "server_unavailable",
              possiblyDispatched: false,
              detail: error instanceof Error ? error.message.slice(0, 500) : "Tracker scope lookup failed",
            };
          }
        }
        const repositoryCall =
          server.id === "linear" && trackerNames.has(input.tool) && trackerRepo !== undefined;
        if (
          repositoryCall &&
          (input.lane !== "operator" || typeof trackerRepo !== "string" || !options.trackerForRepo)
        ) {
          return {
            outcome: "refused",
            reason: "lane_denied",
            detail: "Repository tracker access requires operator tools and a registered repository.",
          };
        }
        let state: ServerState | undefined;
        let confirmed = false;

        try {
          state = await stateFor(server);
          if (google === "google-drive") {
            const credential = await options.credentials.get(server.credential!);
            if (
              credential === undefined ||
              credentialDigest(credential) !== state.credential ||
              typeof input.arguments.fileId !== "string" ||
              !googlePickedFileIds(credential).includes(input.arguments.fileId)
            ) {
              return {
                outcome: "refused",
                reason: "lane_denied",
                possiblyDispatched: false,
                detail: "Choose this file in the Google Drive connection before reading it.",
              };
            }
          }
          const client = repositoryCall ? undefined : await connection(server, state, now);
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
          const workerPost =
            server.id === "linear" && server.credential !== undefined && isLinearWorkerTool(input.tool);
          const credential = workerPost ? await options.credentials.get(server.credential!) : undefined;
          const source = admittedSource;
          // Attribution is optional: losing an owning conversation does not revoke
          // independently admitted connected-account tools.
          let authority: ConversationAuthority | undefined;
          let recipient: LinearRecipient | undefined;
          const refreshAttribution = async () => {
            authority = undefined;
            recipient = undefined;
            if (!publicationCall || (!source && !admittedNativeSource)) return;
            // Assign only the bounded result. A late proof cannot mutate the
            // recipient of a call that already proceeded without attribution.
            const observed = await optionalAttribution(async () => {
              const [owner, native] = await Promise.all([
                (async () =>
                  source && source.current() && (await source.authorize()) && source.current()
                    ? captureConversationAuthority(source)
                    : undefined)().catch(() => undefined),
                (async () =>
                  admittedNativeSource &&
                  admittedNativeSource.current() &&
                  (await admittedNativeSource.authorize()) &&
                  admittedNativeSource.current()
                    ? captureNativeSeatAuthority(admittedNativeSource).recipient
                    : undefined)().catch(() => undefined),
              ]);
              return { owner, native };
            });
            authority = observed?.owner;
            recipient = observed?.native;
            recipient ??= authority ? { kind: "conversation", owner: authority.owner } : undefined;
          };
          // Owned publication backends reprove at their actual beforeWrite
          // boundary. Generic MCP writes need one reproof before dispatch.
          if (!repositoryCall && !isLocalTracker(server) && !isApiTracker(server) && !workerPost)
            await refreshAttribution();
          // Admission may await; retain the account/config fence after it, then
          // check revocation without yielding again before provider dispatch.
          const current = input.fence ? await input.fence() : undefined;
          await assertCurrent(server, state);
          let commitCurrent = current;
          const assertDispatch = () => {
            try {
              signal.throwIfAborted();
              if (Date.now() >= deadline)
                throw new Error(`MCP ${input.server}/${input.tool} timed out after ${timeoutMs}ms`);
              if (closed || states.get(server.id) !== state)
                throw new Error(`${server.id} connection changed`);
              commitCurrent?.();
            } catch (error) {
              throw new DispatchRefused(error instanceof Error ? error.message : "MCP dispatch refused");
            }
          };
          assertDispatch();
          const notifyDispatch = () => {
            assertDispatch();
            if (!dispatched) {
              input.onDispatch?.();
              // Synchronous receipt persistence may consume the remaining budget.
              assertDispatch();
              dispatched = true;
              if (server.id === "linear" && !isReadTool(input.tool)) trackerReads.invalidate();
            }
          };
          const publication = {
            beforeWrite: async () => {
              try {
                await refreshAttribution();
                commitCurrent = await input.fence?.();
                await assertCurrent(server, state!);
                assertDispatch();
              } catch (error) {
                throw new DispatchRefused(
                  error instanceof Error ? error.message : "Tracker publication refused",
                );
              }
            },
            onDispatch: () => {
              try {
                notifyDispatch();
              } catch (error) {
                throw new DispatchRefused(
                  error instanceof Error ? error.message : "Tracker publication refused",
                );
              }
            },
            effectConfirmed: () => {
              // The backend knows the effect committed, but its result is not
              // available yet. Notify the projected receipt once it returns.
              confirmed = true;
            },
          };
          const aliases: Record<string, string> = {
            search_issues: "list_issues",
            create_comment: "save_comment",
            create_issue_label: "save_issue_label",
          };
          const upstreamTool =
            !isLocalTracker(server) &&
            server.id === "linear" &&
            (input.tool === "search_issues" || state.nativeToolNames?.has(input.tool) === false)
              ? (aliases[input.tool] ?? input.tool)
              : input.tool;
          const selected = state;
          const collection = (
            {
              list_issues: "issues",
              list_milestones: "milestones",
              list_initiatives: "initiatives",
              list_projects: "projects",
            } as Record<string, string>
          )[upstreamTool];
          const priorityRead =
            !repositoryCall &&
            server.id === "linear" &&
            collection !== undefined &&
            (isApiTracker(server) || (!isLocalTracker(server) && options.localTracker !== undefined));
          let providerPages = 0;
          selected.activeCalls += 1;
          let result: Awaited<ReturnType<McpConnection["callTool"]>>;
          try {
            result = repositoryCall
              ? {
                  content: JSON.stringify(
                    await options.trackerForRepo!({
                      name: input.tool,
                      repo: trackerRepo as string,
                      args: Object.fromEntries(
                        Object.entries(input.arguments).filter(([key]) => key !== "repo"),
                      ),
                      lane: input.lane,
                      local: input.lane === "operator" && input.delegation === undefined && !inferredRepo,
                      ...publication,
                    }),
                  ),
                  isError: false,
                }
              : isApiTracker(server) && !workerPost
                ? collection !== undefined
                  ? await callCachedLinearCollection(
                      trackerReads,
                      input.arguments,
                      async (args) => {
                        await assertCurrent(server, state!);
                        current?.();
                        providerPages += 1;
                        return {
                          content: JSON.stringify(
                            await options.linearApiTracker!.call(upstreamTool, args, publication),
                          ),
                          isError: false,
                        };
                      },
                      JSON.stringify([connectedAccount?.binding, state!.configuration, state!.credential]),
                      collection,
                    )
                  : {
                      content: JSON.stringify(
                        await options.linearApiTracker!.call(input.tool, input.arguments, publication),
                      ),
                      isError: false,
                    }
                : isLocalTracker(server)
                  ? {
                      content: JSON.stringify(
                        await options.localTracker!.call(input.tool, input.arguments, publication),
                      ),
                      isError: false,
                    }
                  : workerPost
                    ? await publishLinearWorker({
                        tool: input.tool,
                        args: input.arguments,
                        credential,
                        author: options.linearAuthor ?? (async () => undefined),
                        signal,
                        beforeDispatch: notifyDispatch,
                        beforeWrite: async () => {
                          await refreshAttribution();
                          commitCurrent = await input.fence?.();
                          await assertCurrent(server, state!);
                          assertDispatch();
                        },
                        ...(options.linearFetch ? { fetch: options.linearFetch } : {}),
                      })
                    : await dispatchFence.run(notifyDispatch, () => {
                        const callUpstream = async (args: Record<string, unknown>) => {
                          await assertCurrent(server, state!);
                          assertDispatch();
                          if (!client!.dispatchesAtWire) notifyDispatch();
                          if (priorityRead) providerPages += 1;
                          // Observe the admitted original response under the existing
                          // provider cap, even after the caller's shorter deadline.
                          return client!.callTool(upstreamTool, args, REQUEST_TIMEOUT_MS);
                        };
                        return options.localTracker && server.id === "linear" && collection !== undefined
                          ? callCachedLinearCollection(
                              trackerReads,
                              input.arguments,
                              callUpstream,
                              JSON.stringify([
                                connectedAccount?.binding,
                                state!.configuration,
                                state!.credential,
                              ]),
                              collection,
                            )
                          : callUpstream(input.arguments);
                      });
            if (priorityRead) {
              // A shared/cached read never borrows the first caller's grant. Every
              // waiter rechecks its own revocation and account/config generation.
              commitCurrent = await input.fence?.();
              await assertCurrent(server, selected);
              assertDispatch();
            }
          } finally {
            if (dispatched && server.id === "linear" && !isReadTool(input.tool)) trackerReads.invalidate();
            selected.activeCalls -= 1;
            // Provider settlement releases the connection; receipt observers
            // can still await without retaining an obsolete transport.
            if (selected.retired) void closeRetired(selected);
          }
          const content =
            input.resultMode !== "data" && server.id === "linear" && !result.isError
              ? compactLinearWrite(input.tool, result.content)
              : result.content;
          const settled = {
            content: input.resultMode === "data" ? content : content.slice(0, MAX_RESULT_CHARACTERS),
            isError: result.isError,
          };
          const readOnly =
            !dispatched &&
            (repositoryCall || isLocalTracker(server) || isApiTracker(server) || priorityRead) &&
            /^(?:get|list|search)_/u.test(input.tool) &&
            TRACKER_TOOLS.some((tool) => tool.name === input.tool);
          // These owned backend reads need no mutation admission. Provider
          // responses and unpublished writes must never manufacture that proof.
          input.onSettled?.(settled, readOnly ? { readOnly: true } : undefined);
          options.logger.info(
            {
              event: "mcp.host.call",
              server: server.id,
              tool: input.tool,
              ...(priorityRead ? { trackerRead: { providerPages } } : {}),
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
            await options.observeCall?.({
              server: server.id,
              tool: input.tool,
              content: result.content,
              arguments: input.arguments,
              ...(authority ? { owner: authority.owner } : {}),
              ...(recipient ? { recipient } : {}),
              isError: result.isError,
              ...(connectedAccount === undefined || !("account" in connectedAccount)
                ? {}
                : { account: connectedAccount.account }),
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
          if (
            input.resultMode === "data" &&
            Buffer.byteLength(result.content, "utf8") > MAX_DATA_RESULT_BYTES
          ) {
            return {
              outcome: "refused",
              reason: "result_too_large",
              possiblyDispatched: true,
              detail: `MCP ${server.id}/${input.tool} result exceeds ${MAX_DATA_RESULT_BYTES} bytes; request a smaller page or fewer fields`,
            };
          }
          // Callers asking for data get the full record; model-facing results get a receipt.
          return { outcome: "ok", ...settled };
        } catch (error) {
          // A call that fails may have killed the process; drop the connection so
          // the next attempt reconnects instead of writing to a closed pipe.
          if (
            dispatched &&
            !confirmed &&
            !(error instanceof DispatchRefused) &&
            state !== undefined &&
            state.failure === undefined
          )
            await retire(server.id, state);
          return {
            outcome: "refused",
            reason: "server_unavailable",
            possiblyDispatched: dispatched,
            detail: error instanceof Error ? error.message.slice(0, 500) : "mcp_call_failed",
          };
        }
      };
      // The original provider operation retains its hold and settlement hook.
      return new Promise<McpCallResult>((resolve) => {
        const timedOut = () =>
          resolve({
            outcome: "refused",
            reason: "server_unavailable",
            possiblyDispatched: dispatched,
            detail: `MCP ${input.server}/${input.tool} timed out after ${timeoutMs}ms`,
          });
        signal.addEventListener("abort", timedOut, { once: true });
        void perform().then(
          (result) => {
            signal.removeEventListener("abort", timedOut);
            resolve(result);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", timedOut);
            resolve({
              outcome: "refused",
              reason: "server_unavailable",
              possiblyDispatched: dispatched,
              detail: error instanceof Error ? error.message : "MCP call failed",
            });
          },
        );
      });
    },

    async close() {
      closed = true;
      trackerReads.close();
      await Promise.all([...states].map(([id, state]) => retire(id, state)));
      await Promise.all([...retired].map((state) => closeRetired(state)));
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
    dispatchesAtWire: true,
    async listTools() {
      const collected: { name: string; description?: string | undefined; inputSchema?: unknown }[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      do {
        // Validate the envelope here, then each tool in toolsFor. The SDK's
        // listTools validates the entire array and would lose every healthy
        // tool when just one provider entry has a rejected schema.
        const page = await client.request(
          { method: "tools/list", params: cursor === undefined ? {} : { cursor } },
          z.object({ tools: z.array(z.unknown()), nextCursor: z.string().optional() }),
          { timeout: REQUEST_TIMEOUT_MS },
        );
        collected.push(
          ...page.tools.map((tool) =>
            typeof tool === "object" && tool !== null
              ? (tool as { name: string; description?: string | undefined; inputSchema?: unknown })
              : { name: "<unnamed>", inputSchema: tool },
          ),
        );
        const next =
          typeof page.nextCursor === "string" && page.nextCursor.length > 0 ? page.nextCursor : undefined;
        if (next !== undefined && seenCursors.has(next)) throw new Error("mcp_catalog_cursor_repeated");
        if (next !== undefined) seenCursors.add(next);
        cursor = next;
      } while (cursor !== undefined);
      return collected;
    },

    async callTool(name, args, timeoutMs) {
      const result = await client.callTool({ name, arguments: args }, undefined, {
        timeout:
          timeoutMs === undefined
            ? REQUEST_TIMEOUT_MS
            : z.number().int().positive().max(1_200_000).parse(timeoutMs),
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
  credentials: Pick<CredentialStore, "get"> & Partial<Pick<CredentialStore, "updateMany">>,
  expectedCredential: string,
): Promise<StdioClientTransport | StreamableHTTPClientTransport> {
  const selectedBearer = async (): Promise<string> => {
    const google = googleProvider(server);
    if (google !== undefined) {
      if (!credentials.updateMany || !server.credential || normalizeProviderId(server.credential) !== google)
        throw new Error("Google access requires a locked managed provider credential binding");
      let bearer: string | undefined;
      // Read the grant and durable disable epoch in one existing broker lock.
      // A partial Keychain publication or replacement account cannot combine
      // an old grant with a separately awaited marker. This projection writes nothing.
      await credentials.updateMany([GOOGLE_OAUTH_APP_PROVIDER_ID, google], async (group) => {
        const stored = group[google];
        assertGoogleCredentialBinding(server, stored);
        if (stored === undefined || credentialDigest(stored) !== expectedCredential)
          throw new Error(server.id + " credential changed; reconnect before calling tools");
        const metadata = googleCredentialMetadata(stored);
        const app = group[GOOGLE_OAUTH_APP_PROVIDER_ID];
        if (
          metadata?.status !== "connected" ||
          !googleCredentialUsable(stored, google) ||
          googleAppSecret(app, metadata.clientId) === undefined ||
          (metadata.identityEpoch ?? "0") !== googleIdentityEpoch(app, metadata)
        )
          throw new Error("Google connection is disabled or requires reconnecting");
        bearer = providerCredentialBearer(stored);
        return group;
      });
      if (!bearer) throw new Error(server.id + " has no usable stored credential");
      return bearer;
    }
    const stored = server.credential === undefined ? undefined : await credentials.get(server.credential);
    if (stored === undefined || credentialDigest(stored) !== expectedCredential) {
      throw new Error(`${server.id} credential changed; reconnect before calling tools`);
    }
    if (stored.type === "oauth" && stored.expires !== 0 && stored.expires <= Date.now()) {
      throw new Error(`${server.id} credential expired; reconnect to refresh`);
    }
    if (stored?.type === "oauth" && stored.linearAuth === "api")
      throw new Error("Registered Linear API credentials cannot authenticate MCP");
    assertGoogleCredentialBinding(server, stored);
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
          try {
            headers.set("authorization", `Bearer ${await selectedBearer()}`);
          } catch (error) {
            if (dispatchFence.getStore())
              throw new DispatchRefused(
                error instanceof Error ? error.message : "Connected credential changed",
              );
            throw error;
          }
        }
        dispatchFence.getStore()?.();
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
  const transport = new StdioClientTransport({
    command: server.command,
    args: [...server.args],
    ...((server as McpServerSettings & { cwd?: string }).cwd === undefined
      ? {}
      : { cwd: (server as McpServerSettings & { cwd?: string }).cwd }),
    env: environment,
    // Servers chat on stderr; it must not land in the operator's console.
    stderr: "ignore",
  });
  const send = transport.send.bind(transport);
  transport.send = async (message) => {
    if (googleProvider(server) !== undefined) {
      try {
        // Validate the captured process credential; never replace its environment token.
        await selectedBearer();
      } catch (error) {
        if (dispatchFence.getStore())
          throw new DispatchRefused(error instanceof Error ? error.message : "Connected credential changed");
        throw error;
      }
    }
    dispatchFence.getStore()?.();
    return send(message);
  };
  return transport;
}
