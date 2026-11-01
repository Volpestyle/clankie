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
import { WATCH_REFUSAL } from "./watch.ts";
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
import { canonicalJson } from "@clankie/play";
import { GoogleAccountProviderSchema, type GoogleAccountProvider } from "@clankie/protocol/accounts";
import type { McpServerSettings, SettingsStore } from "@clankie/settings";
import type { ProviderRequestBudget, TrackerGraphqlPlan, TrackerMcpAdapter } from "./ports/tracker-mcp.ts";
import type { ProjectProcessProof } from "./project-process-proof.ts";
import { mcpToolSchemaError } from "./mcp-tool-schema.ts";
import {
  OWNER_APP_TOOLS,
  refuseBuiltInTrackerFeatures,
  trackerArgumentReferences,
  TRACKER_LEAD,
  TRACKER_OWNER,
  TRACKER_TOOLS,
  TrackerReadRejected,
  trackerRoleRefusal,
  type TrackerActor,
  type TrackerRole,
  type TrackerToolBackend,
  type TrackerToolCallOptions,
  type LocalTrackerBackend,
} from "@clankie/work-items";
import type { WorkerReadReceiptHost, WorkerReadSnapshot } from "./worker-mcp.ts";
import { createPrioritySortedLinearIssueReader, callCachedLinearCollection } from "./tracker-tool-router.ts";
import {
  currentLinearRequestPriority,
  withLinearRequestPriority,
  withinLinearRequestInvocation,
  type LinearRequestPriority,
} from "./tracker-request-priority.ts";
import { TrackerRequestBudgetRefused, type TrackerRequestBudget } from "./tracker-request-budget.ts";
import { isTrackerWriteTool, TRACKER_POSTING_ADMITTED, type TrackerPostingGate } from "./tracker-posting.ts";

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
/** Host arguments on every tracker tool; the host consumes them before any backend sees the call. */
const trackerHostProperties = (name: string): Record<string, unknown> => ({
  repo: {
    type: "string",
    description:
      "Optional registered repository or absolute path (operator tools only); follows its saved tracker convention.",
  },
  ...(isReadTool(name)
    ? {
        linearHistory: {
          type: "boolean",
          description:
            "Read connected Linear itself as history, even for an item of a project that cut over to the built-in tracker. The result is marked as Linear history; current state lives in the built-in tracker.",
        },
      }
    : {}),
});
const LINEAR_HISTORY_NOTE =
  "Linear history: this was read from connected Linear. Projects cut over to the built-in tracker stopped updating there; their current state is in the built-in tracker (call without linearHistory).";
/** Marks a read of connected Linear that touched a cut-over project's frozen copy (VUH-2829). */
const markLinearHistory = (content: string) => {
  let result: unknown = content;
  try {
    result = JSON.parse(content);
  } catch {
    // Text results stay text inside the marked envelope.
  }
  return JSON.stringify({ linearHistory: LINEAR_HISTORY_NOTE, result });
};
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
  /**
   * Writes as a worker persona: a grant must bind the exact personaId, and a
   * project's standing access leaves it out.
   */
  readonly writesAsPersona?: boolean;
}

type McpRefusalReason =
  | "unknown_server"
  | "lane_denied"
  | "server_unavailable"
  | "result_too_large"
  | "linear_request_budget"
  | "tracker_request_budget"
  | "role_not_allowed"
  | "body_owned"
  | "invalid_arguments"
  | "confirmation_required"
  /** Posting to this project's tracker refused the write (ADR 0302); nothing was written. */
  | "posting_refused"
  /** The write waits for the owner's or the lead's OK (ADR 0302); nothing was written yet. */
  | "posting_held";

/** In-process service capability; HTTP/model arguments can never construct this symbol. */
export const MINECRAFT_BODY_ACCESS = Symbol("minecraft-body-access");

type McpCallResult =
  | { readonly outcome: "ok"; readonly content: string; readonly isError: boolean }
  | {
      readonly outcome: "refused";
      readonly reason: McpRefusalReason;
      readonly detail: string;
      readonly possiblyDispatched?: boolean;
      readonly retryAt?: number;
      readonly retryAfterMs?: number;
      /** The caller's host-resolved tracker role, on a role_not_allowed refusal. */
      readonly role?: TrackerRole;
    };

export interface McpHost extends WorkerReadReceiptHost {
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
  /** A hired seat's tracker role from its hire and project policy (LOCAL-VUH-45). */
  trackerRole?(principalId: string): Promise<"worker" | "reviewer">;
  /** A verified provider change retires cached lists, including self-echo webhooks. */
  invalidateTrackerReads?(): void;
  /**
   * Discovers active servers in the background; service boot must not await it.
   * Explicit tool searches can wait for discovery. Individual failures are isolated:
   * a server that is down costs him its tools, not his ability to answer.
   */
  warm(): Promise<void>;
  /** Every reachable tool; readyOnly takes a validated snapshot and starts pending discovery. */
  catalog(
    lane: CaptainSessionLaneV2,
    options?: { readonly readyOnly?: boolean },
  ): Promise<readonly McpToolDescriptor[]>;
  /** Readiness of configured, lane-admitted servers; absence of tools is not proof of absence. */
  catalogStatus?(lane: CaptainSessionLaneV2): Promise<
    readonly {
      server: string;
      status: "ready" | "connecting" | "unavailable";
    }[]
  >;
  call(input: {
    readonly lane: CaptainSessionLaneV2;
    readonly server: string;
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
    /** Internal data consumers only; model-facing calls retain the default 50k character cap. */
    readonly resultMode?: "model" | "data";
    /** Internal scheduling only. Background reads yield once the account reaches 80%. */
    readonly requestPriority?: LinearRequestPriority;
    /** Total caller budget, including setup; never a model tool argument. */
    readonly timeoutMs?: number;
    /** The caller went away; a waiting tracker read stops with it. */
    readonly signal?: AbortSignal;
    /** Only MinecraftMcpPort holds Clankie's motor; raw and delegated routes are denied. */
    readonly bodyAccess?: typeof MINECRAFT_BODY_ACCESS;
    /**
     * Host-only, for "Posting to your tracker" (ADR 0302): a write the check already let
     * through, or the project a host caller writes for. Never a model argument.
     */
    readonly posting?: typeof TRACKER_POSTING_ADMITTED | { readonly projectId: string };
    readonly delegation?: { binding: string; grantId: string; principalId: string; workId: string };
    /** Async admission may return a synchronous revocation check run after the final host reads. */
    readonly fence?: () => Promise<void | (() => void)>;
    /** Host-stamped turn attribution; it grants no provider tools. */
    readonly conversationAuthority?: ConversationAuthority;
    /** Seat-bound leads cannot dispatch a tracker call without their chat attribution. */
    readonly requireConversationAttribution?: boolean;
    /** Host-stamped model of the calling turn, recorded by the built-in tracker; never a tool argument. */
    readonly model?: string;
    /** Host-only socket/controller proof for native author attribution; never a grant. */
    readonly nativeWriteProof?: (signal?: AbortSignal) => Promise<ProjectProcessProof | undefined>;
    /** Internal receipt hooks; never caller/model arguments. */
    readonly onDispatch?: () => void;
    /**
     * Backend-owned pre-effect READ proof; never caller/model arguments. Supplied only by a caller
     * that can retain the proof, and it classifies the receipt READ or throws to refuse.
     */
    readonly onReadPrepared?: (snapshot: WorkerReadSnapshot) => void;
    /** Optional native receipt provenance, prepared only at the locked default READ boundary. */
    readonly readReceiptFence?: () => Promise<void | (() => void)>;
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

/**
 * Collects a route lookup's synchronous freshness checks. Each check throws when an input the
 * lookup read has changed since, so a commit under the store lock sees the route it was given.
 */
export type TrackerRouteFence = (assertCurrent: () => void) => void;

export interface McpHostOptions {
  /** The same body-owned developer app as /v1/accounts; no secret leaves the broker. */
  readonly googleApps?: () => Promise<GoogleOAuthApp>;
  readonly googleFetch?: typeof fetch;
  readonly googleEndpoints?: GoogleOAuthEndpoints;
  /** The durable fallback. Connected transport failures never select this backend. */
  readonly localTracker?: TrackerToolBackend &
    Partial<Pick<LocalTrackerBackend, "withReadSnapshot" | "readSnapshotCandidate">>;
  /** Registered GraphQL OAuth, with a separate broker audience from MCP. */
  readonly linearApiTracker?: TrackerToolBackend;
  readonly linearRequestBudget?: ProviderRequestBudget;
  /**
   * The connected tracker's own tools beyond its server's list, which its extension
   * supplies (ADR 0328). Without it the host serves only what the server lists.
   */
  readonly trackerMcp?: TrackerMcpAdapter;
  readonly trackerIdentity?: string;
  /** Internal clock for list freshness; never a caller/model argument. */
  readonly trackerReadClock?: () => number;
  /**
   * Read-only lookup in already registered stores; never enrolls a repository. With `fence`, it
   * registers synchronous checks that the inputs it read still hold.
   */
  readonly trackerRepoForCall?: (
    name: string,
    args: Record<string, unknown>,
    fence?: TrackerRouteFence,
  ) => Promise<string | undefined>;
  /**
   * The tracker repo a delegated principal's hire routes to when it names none (VUH-2014):
   * its registered project's repo when that project's convention is not `linear`,
   * undefined when it has no project or tracks in Linear. Throws to refuse. With `fence`, it
   * registers synchronous checks that the hire and inputs it read still hold.
   */
  readonly trackerRepoForWorker?: (
    principalId: string,
    fence?: TrackerRouteFence,
  ) => Promise<string | undefined>;
  /**
   * The cut-over project whose built-in tracker holds a record these references name
   * (VUH-2829), whoever calls: its repo routes the call there, so it never reaches the
   * frozen Linear copy. Undefined when they name none. Throws to refuse.
   */
  readonly trackerRepoForItem?: (
    references: readonly string[],
    fence?: TrackerRouteFence,
  ) => Promise<{ repo: string; project: string } | undefined>;
  /** Host-only authority: caller roles and inherited worker attribution grant no closure. */
  readonly prepareTrackerLeadClosure?: (
    source: ConversationAuthority,
    projectId: string | null,
  ) => Promise<() => void>;
  /** Repository conventions are backends of the same public tracker vocabulary. */
  readonly trackerForRepo?: (input: {
    name: string;
    args: Record<string, unknown>;
    repo: string;
    lane: CaptainSessionLaneV2;
    /** Only the native owner operator, never a delegated worker, may enroll paths. */
    local: boolean;
    /** Host-authenticated writer the built-in tracker records. */
    actor: TrackerActor;
    authorizeLeadClosure?: NonNullable<TrackerToolCallOptions["authorizeLeadClosure"]>;
    beforeWrite(): Promise<void>;
    onDispatch(): void;
    effectConfirmed(): void;
  }) => Promise<unknown>;
  /** Display name for a delegated worker principal (its hired seat); never from tool arguments. */
  readonly trackerWorkerName?: (principalId: string) => string | undefined;
  /**
   * A delegated principal's tracker role from its hire and project policy (ADR 0216),
   * never its own claim. Absent or failing resolution is the narrowest role, worker.
   */
  readonly trackerRoleForWorker?: (principalId: string) => Promise<"worker" | "reviewer">;
  /** Per-worker budget on Clankie's own trackers (LOCAL-VUH-45); the owner and Clankie are unlimited. */
  readonly trackerRequestBudget?: TrackerRequestBudget;
  /** The check every outward tracker write passes (ADR 0302); absent, writes are not checked. */
  readonly trackerPosting?: Pick<TrackerPostingGate, "admit" | "repoTarget">;
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
  listing?: Promise<readonly McpToolDescriptor[]>;
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

/** Catalogued tracker reads: the get_, list_ and search_ tools. */
const trackerReadTool = (tool: string) =>
  /^(?:get|list|search)_/u.test(tool) && TRACKER_TOOLS.some((entry) => entry.name === tool);

/**
 * Whether save_issue's state names a completed status, matched as the tracker matches it.
 * An unreadable status list leaves closure to the tracker, which refuses it without the
 * lead's closure capability.
 */
async function closesIssue(
  read: (name: string, args: Record<string, unknown>) => Promise<unknown>,
  args: Record<string, unknown>,
): Promise<boolean> {
  try {
    const team =
      typeof args.team === "string"
        ? args.team
        : ((await read("list_teams", {})) as { teams?: { id: string }[] }).teams?.[0]?.id;
    if (team === undefined) return false;
    const statuses = (await read("list_issue_statuses", { team })) as {
      id: string;
      name: string;
      type: string;
    }[];
    const norm = (value: string) => value.trim().toLowerCase();
    const reference = norm(args.state as string);
    const status =
      statuses.find((entry) => norm(entry.id) === reference || norm(entry.name) === reference) ??
      statuses.find((entry) => norm(entry.type) === reference);
    return status?.type === "completed";
  } catch {
    return false;
  }
}

export function createMcpHost(options: McpHostOptions): McpHost {
  const googleApps =
    options.googleApps ?? (async () => (await options.settings.load()).oauthApps?.google ?? {});
  const connectImpl =
    options.connect ??
    ((server: McpServerSettings, credentials: Pick<CredentialStore, "get">, expectedCredential: string) =>
      connectServer(server, credentials, expectedCredential, options.linearRequestBudget));

  const curated = options.curated ?? CURATED_MCP_SERVERS;
  const states = new Map<string, ServerState>();
  const retired = new Set<ServerState>();
  const missingCredentials = new Set<string>();
  const failedDiscovery = new Map<string, string>();
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
  // The owner app's verdict (ADR 0299) is never offered to an agent; a call by name still reaches
  // the tracker, which refuses it without the host's ownerApp proof.
  const listedTrackerCatalog = trackerCatalog.filter((tool) => !OWNER_APP_TOOLS.has(tool.name));
  const trackerRole = async (principalId: string): Promise<"worker" | "reviewer"> =>
    // An unresolvable role gets the narrowest profile.
    options.trackerRoleForWorker
      ? await options.trackerRoleForWorker(principalId).catch(() => "worker" as const)
      : "worker";
  const localBinding = createHash("sha256")
    .update(JSON.stringify(["local-tracker", options.trackerIdentity ?? "service-tracker"]))
    .digest("hex");
  // The GraphQL escape hatch is independent of the MCP transport and of the
  // tracker backend; the call decides whether a connected app can run it.
  const trackerMcp = options.trackerMcp;
  const graphqlDescriptors = (): McpToolDescriptor[] =>
    trackerMcp
      ? [
          {
            ...trackerMcp.graphql.tool,
            inputSchema: trackerMcp.graphql.tool.inputSchema as Record<string, unknown>,
            server: "linear",
            qualifiedName: `linear_${trackerMcp.graphql.tool.name}`,
            initial: false,
          },
        ]
      : [];
  const canonicalTrackerCatalog = (): McpToolDescriptor[] => [
    ...graphqlDescriptors(),
    ...listedTrackerCatalog.map((tool) => ({
      ...tool,
      server: "linear",
      qualifiedName: `linear_${tool.name}`,
      initial: CURATED_MCP_SERVERS[0]!.initialTools.includes(tool.name),
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...(tool.inputSchema as { properties?: Record<string, unknown> }).properties,
          ...trackerHostProperties(tool.name),
        },
      },
    })),
  ];

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
      const selected = stored;
      const request = options.linearFetch ?? fetch;
      const refreshFetch: typeof fetch = (input, init) =>
        server.id === "linear" &&
        options.linearRequestBudget &&
        String(input instanceof Request ? input.url : input) === "https://api.linear.app/graphql"
          ? options.linearRequestBudget.fetch(selected, request, input, init)
          : request(input, init);
      await resolveProviderBearer(server.credential, options.credentials, Date.now(), {
        fetch: refreshFetch,
      });
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
      listTools: async () => listedTrackerCatalog,
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
    const key = JSON.stringify(server);
    try {
      const tools = await loadTools(server, now);
      if (failedDiscovery.get(server.id) === key) failedDiscovery.delete(server.id);
      return tools;
    } catch (error) {
      failedDiscovery.set(server.id, key);
      throw error;
    }
  }

  async function loadTools(server: McpServerSettings, now: number): Promise<readonly McpToolDescriptor[]> {
    const state = await stateFor(server);
    if (state.tools !== undefined) {
      await assertCurrent(server, state);
      return state.tools;
    }
    if (state.listing !== undefined) return state.listing;
    if (state.failure !== undefined && now - state.failure.at < FAILURE_COOLDOWN_MS)
      throw new Error(state.failure.reason);
    const listing = discoverTools(server, state, now)
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : "mcp_discovery_failed";
        state.failure = { reason, at: Date.now() };
        options.logger.warn(
          { event: "mcp.host.discovery_failed", server: server.id, reason },
          "mcp catalog unavailable",
        );
        throw error;
      })
      .finally(() => {
        delete state.listing;
      });
    state.listing = listing;
    return listing;
  }

  async function discoverTools(server: McpServerSettings, state: ServerState, now: number) {
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
      ? options.linearApiTracker!.catalog().filter((tool) => !OWNER_APP_TOOLS.has(tool.name))
      : server.id === "linear" && (options.localTracker || options.linearApiTracker)
        ? [...listed.filter((tool) => !trackerNames.has(tool.name)), ...listedTrackerCatalog]
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
                      ...trackerHostProperties(tool.name),
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
      options.linearAuthor &&
      trackerMcp
    ) {
      projected.push(
        ...trackerMcp.workerTools.map((tool) => ({
          ...tool,
          inputSchema: tool.inputSchema as Record<string, unknown>,
          server: "linear",
          qualifiedName: `linear_${tool.name}`,
          initial: true,
        })),
      );
    }
    if (
      server.id === "linear" &&
      (options.localTracker || options.linearApiTracker) &&
      !projected.some((tool) => tool.name === trackerMcp?.graphql.tool.name)
    )
      projected.push(...graphqlDescriptors());
    // A server's own tool of the same name is still published as the persona.
    const tools = projected.map((tool) =>
      server.id === "linear" && trackerMcp?.isWorkerTool(tool.name)
        ? { ...tool, writesAsPersona: true }
        : tool,
    );
    state.tools = tools;
    delete state.failure;
    return tools;
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

  /** Fence settings and the selected host generation for the synchronous backend/core commit. */
  async function defaultReadFence(
    server: McpServerSettings,
    state: ServerState,
    principalId: string,
    signal: AbortSignal,
    call?: { tool: string; args: Record<string, unknown> },
  ): Promise<() => void> {
    signal.throwIfAborted();
    if (!isLocalTracker(server)) throw new Error("The original default tracker is unavailable");
    await assertCurrent(server, state);
    const currentAccount = await account(server, state.credential);
    if (currentAccount.binding !== localBinding || currentAccount.backend !== "local")
      throw new Error("The original default tracker account changed");
    const settingsFence = await options.settings.loadFenced();
    // Routing awaits; its inputs are fenced again synchronously at commit, with the settings
    // (projects and their bindings) under the settings fence above.
    const routeChecks: (() => void)[] = [];
    const routeFence: TrackerRouteFence = (check) => void routeChecks.push(check);
    if (
      call &&
      (await options.trackerRepoForItem?.(trackerArgumentReferences(call.args), routeFence)) !== undefined
    )
      throw new Error("The original call now names a cut-over project's item");
    if ((await options.trackerRepoForWorker?.(principalId, routeFence)) !== undefined)
      throw new Error("The worker's tracker route changed");
    if (call && (await options.trackerRepoForCall?.(call.tool, call.args, routeFence)) !== undefined)
      throw new Error("The original call now routes to a repository tracker");
    // Routing can await. Keep the ordinary current-account/configuration guard last.
    await assertCurrent(server, state);
    const assertFinal = () => {
      signal.throwIfAborted();
      settingsFence.assertCurrent();
      if (closed || states.get(server.id) !== state)
        throw new Error("The original default tracker configuration changed");
      for (const check of routeChecks) check();
    };
    assertFinal();
    return assertFinal;
  }

  return {
    invalidateTrackerReads: () => trackerReads.invalidate(),
    async withReadReceiptTarget(input, prepare) {
      const { snapshot, principalId, signal } = input;
      const tracker = options.localTracker;
      if (
        !tracker?.withReadSnapshot ||
        snapshot.server !== "linear" ||
        snapshot.tool !== snapshot.operation ||
        snapshot.target.repo !== undefined ||
        snapshot.accountBinding !== localBinding ||
        snapshot.target.resourceBinding !== localBinding
      )
        throw new Error("The original default tracker READ target is unproven");
      signal.throwIfAborted();
      const server = (await activeServers()).find((entry) => entry.id === snapshot.server);
      if (!server || !isLocalTracker(server) || !laneAllows(server, "operator"))
        throw new Error("The original default tracker route changed");
      const state = await stateFor(server);
      const originalCall = { tool: snapshot.tool, args: snapshot.routingArguments };
      // Core native/account authorization and host routing may await: prepare both
      // before the store lock, so under it only synchronous checks precede the commit.
      const commit = await prepare();
      const hostFence = await defaultReadFence(server, state, principalId, signal, originalCall);
      return tracker.withReadSnapshot(snapshot, async (assertStoreCurrent) => {
        const assertTargetCurrent = () => {
          assertStoreCurrent();
          hostFence();
        };
        assertTargetCurrent();
        return commit(assertTargetCurrent);
      });
    },
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
    trackerRole,
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

    async catalog(lane, catalogOptions) {
      const now = Date.now();
      const collected: McpToolDescriptor[] = [];
      for (const server of await activeServers()) {
        if (server.id === "minecraft") continue;
        if (!laneAllows(server, lane)) continue;
        try {
          if (catalogOptions?.readyOnly) {
            // Start discovery without putting remote initialization, OAuth refresh,
            // or tools/list on the first conversational turn's critical path.
            void toolsFor(server, now).catch(() => undefined);
            const state = states.get(server.id);
            if (state?.tools !== undefined) {
              await assertCurrent(server, state);
              collected.push(...state.tools);
            } else if (server.id === "linear" && (options.localTracker || options.linearApiTracker)) {
              collected.push(...canonicalTrackerCatalog());
            }
          } else {
            collected.push(...(await toolsFor(server, now)));
          }
        } catch {
          // One unreachable server must not cost him the others. The failure is
          // already logged; the tools simply are not offered this session.
          if (server.id === "linear" && (options.localTracker || options.linearApiTracker))
            collected.push(...canonicalTrackerCatalog());
        }
      }
      return collected;
    },

    async catalogStatus(lane) {
      return (await activeServers())
        .filter((server) => server.id !== "minecraft" && laneAllows(server, lane))
        .map((server) => {
          const state = states.get(server.id);
          return {
            server: server.id,
            status:
              state?.tools !== undefined
                ? ("ready" as const)
                : state?.failure !== undefined || failedDiscovery.get(server.id) === JSON.stringify(server)
                  ? ("unavailable" as const)
                  : ("connecting" as const),
          };
        });
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
      // A host argument (VUH-2829): no backend or provider sees it.
      const linearHistory = input.server === "linear" && input.arguments.linearHistory === true;
      if (input.server === "linear") delete input.arguments.linearHistory;
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
      const graphqlCall =
        input.server === "linear" &&
        trackerMcp !== undefined &&
        input.tool === trackerMcp.graphql.tool.name &&
        (options.localTracker !== undefined || options.linearApiTracker !== undefined);
      const perform = async (): Promise<McpCallResult> => {
        let graphqlPlan: TrackerGraphqlPlan | undefined;
        if (graphqlCall) {
          try {
            graphqlPlan = trackerMcp!.graphql.plan(input.arguments);
          } catch (error) {
            const refusal = trackerMcp!.graphql.refusal(error);
            if (!refusal) throw error;
            return {
              outcome: "refused",
              reason: refusal.reason,
              possiblyDispatched: false,
              detail: refusal.message,
            };
          }
        }
        // Read discovery never needs a publishing author. This classification
        // only controls optional attribution; fleet/account admission is unchanged.
        // GraphQL runs as the app itself; it carries no worker author.
        const publicationCall = !isReadTool(input.tool) && !graphqlCall;
        const providedSource =
          (publicationCall || input.requireConversationAttribution) && input.conversationAuthority
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
        if (graphqlPlan?.mutation && input.lane !== "operator") {
          return {
            outcome: "refused",
            reason: "lane_denied",
            possiblyDispatched: false,
            detail: "Linear GraphQL mutations run only from operator tools; this lane may run queries.",
          };
        }
        if (graphqlCall && isLocalTracker(server)) {
          return {
            outcome: "refused",
            reason: "server_unavailable",
            possiblyDispatched: false,
            detail: `linear_graphql requires connected Linear; the tracker is using the durable local store. ${trackerMcp!.graphql.reconnect}`,
          };
        }
        // Only an operation that can change Linear retires cached tracker lists.
        const linearWrite =
          server.id === "linear" && (graphqlPlan ? graphqlPlan.mutation : !isReadTool(input.tool));
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
        // Reading the frozen Linear copy is explicit, and its result says so (VUH-2829).
        let markHistory = linearHistory;
        if (linearHistory && (graphqlCall || !isReadTool(input.tool) || trackerRepo !== undefined))
          return {
            outcome: "refused",
            reason: "invalid_arguments",
            possiblyDispatched: false,
            detail: "linearHistory marks a read of connected Linear; writes and repo calls cannot use it.",
          };
        if (linearHistory && isLocalTracker(server))
          return {
            outcome: "refused",
            reason: "server_unavailable",
            possiblyDispatched: false,
            detail:
              "Linear is not connected, so there is no Linear history to read. Call without linearHistory.",
          };
        // A call naming a cut-over project's item reaches that project's built-in tracker,
        // whoever calls; what cannot be routed there is refused (VUH-2829, ADR 0226).
        let cutover: { repo: string; project: string } | undefined;
        if (server.id === "linear" && !linearHistory && options.trackerRepoForItem) {
          try {
            cutover = await options.trackerRepoForItem(
              graphqlPlan ? graphqlPlan.references : trackerArgumentReferences(input.arguments),
            );
          } catch (error) {
            return {
              outcome: "refused",
              reason: "lane_denied",
              possiblyDispatched: false,
              detail: error instanceof Error ? error.message.slice(0, 500) : "Tracker routing failed",
            };
          }
        }
        const cutoverPointer =
          cutover &&
          `This names an item of ${cutover.project}, which tracks its work in Clankie's built-in tracker; Linear holds only a frozen copy from before the cutover.`;
        // The built-in tracker answers operator tools only; a room's read stays a marked Linear read.
        if (
          cutover &&
          trackerNames.has(input.tool) &&
          (input.lane === "operator" || !isReadTool(input.tool))
        ) {
          if (trackerRepo === undefined) {
            trackerRepo = cutover.repo;
            inferredRepo = true;
          }
        } else if (cutover && (graphqlPlan ? graphqlPlan.mutation : !isReadTool(input.tool))) {
          return {
            outcome: "refused",
            reason: "lane_denied",
            possiblyDispatched: false,
            detail: `${cutoverPointer} Write it there with the linear_* tracker tools (they route to it) or clankie work --project.`,
          };
        } else if (cutover && !isLocalTracker(server)) markHistory = true;
        // A hired worker's project decides its tracker; an explicit repo still wins (VUH-2014).
        if (
          server.id === "linear" &&
          !linearHistory &&
          input.delegation !== undefined &&
          trackerRepo === undefined &&
          (trackerNames.has(input.tool) || graphqlCall) &&
          options.trackerRepoForWorker
        ) {
          try {
            trackerRepo = await options.trackerRepoForWorker(input.delegation.principalId);
          } catch (error) {
            return {
              outcome: "refused",
              reason: "lane_denied",
              possiblyDispatched: false,
              detail: error instanceof Error ? error.message.slice(0, 500) : "Tracker routing failed",
            };
          }
          if (trackerRepo !== undefined && graphqlCall)
            return {
              outcome: "refused",
              reason: "lane_denied",
              possiblyDispatched: false,
              detail:
                "This worker's project tracks work outside Linear; use the linear_* tracker tools, which reach its saved tracker.",
            };
        }
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
            detail:
              cutover && trackerRepo === cutover.repo
                ? `${cutoverPointer} Reach it from operator tools.`
                : "Repository tracker access requires operator tools and a registered repository.",
          };
        }
        // Connected Linear MCP has no receipts or preconditions; never forward or drop them silently.
        if (
          server.id === "linear" &&
          !repositoryCall &&
          !graphqlCall &&
          !isLocalTracker(server) &&
          !isApiTracker(server)
        ) {
          try {
            refuseBuiltInTrackerFeatures(input.tool, input.arguments);
          } catch (error) {
            return {
              outcome: "refused",
              reason: "invalid_arguments",
              possiblyDispatched: false,
              detail: (error as Error).message,
            };
          }
        }
        // Who writes: an authenticated host identity, never tool arguments (VUH-1916).
        const workerName = input.delegation
          ? options.trackerWorkerName?.(input.delegation.principalId)
          : undefined;
        const trackerActor: TrackerActor = input.delegation
          ? {
              type: "agent-worker",
              id: input.delegation.principalId,
              ...(workerName === undefined ? {} : { name: workerName }),
              onBehalfOf: [TRACKER_OWNER, TRACKER_LEAD],
            }
          : {
              ...TRACKER_LEAD,
              ...(input.model === undefined ? {} : { model: input.model }),
              // Operator tools act for the owner; a social room is Clankie's own act.
              onBehalfOf: input.lane === "operator" ? [TRACKER_OWNER] : [],
            };
        // A hired seat's role profile and budget on the tracker vocabulary (LOCAL-VUH-45).
        // Refusals write nothing and are recorded here, not in the tracker's audit log, so a
        // runaway loop cannot add store writes.
        if (input.delegation !== undefined && server.id === "linear" && trackerNames.has(input.tool)) {
          const principalId = input.delegation.principalId;
          const role = await trackerRole(principalId);
          const owned = repositoryCall || isLocalTracker(server);
          const ownedRead = (name: string, args: Record<string, unknown>) =>
            repositoryCall
              ? options.trackerForRepo!({
                  name,
                  args,
                  repo: trackerRepo as string,
                  lane: input.lane,
                  local: false,
                  actor: trackerActor,
                  beforeWrite: async () => {},
                  onDispatch() {},
                  effectConfirmed() {},
                })
              : options.localTracker!.call(name, args, { actor: trackerActor });
          let refusal = trackerRoleRefusal(role, input.tool, input.arguments);
          if (
            refusal === undefined &&
            owned &&
            input.tool === "save_issue" &&
            typeof input.arguments.state === "string"
          )
            refusal = (await closesIssue(ownedRead, input.arguments))
              ? "closing an issue belongs to the lead or the owner"
              : undefined;
          const actor = {
            id: principalId,
            ...(trackerActor.name === undefined ? {} : { name: trackerActor.name }),
            role,
          };
          if (refusal !== undefined) {
            options.trackerRequestBudget?.refused(actor);
            options.logger.warn(
              {
                event: "tracker.policy.refused",
                reason: "role_not_allowed",
                role,
                tool: input.tool,
                principalId,
              },
              `Tracker ${input.tool} refused for ${role} ${principalId}`,
            );
            return {
              outcome: "refused",
              reason: "role_not_allowed",
              role,
              possiblyDispatched: false,
              detail: `A ${role} may not call ${input.tool}: ${refusal}. Nothing was written. Ask your lead.`,
            };
          }
          if (owned && options.trackerRequestBudget) {
            try {
              options.trackerRequestBudget.admit(
                actor,
                input.requestPriority ?? "interactive",
                !isReadTool(input.tool),
              );
            } catch (error) {
              if (!(error instanceof TrackerRequestBudgetRefused)) throw error;
              options.logger.warn(
                {
                  event: "tracker.policy.refused",
                  reason: "tracker_request_budget",
                  budget: error.reason,
                  priority: input.requestPriority ?? "interactive",
                  role,
                  tool: input.tool,
                  principalId,
                  retryAt: error.retryAt,
                },
                error.message,
              );
              return {
                outcome: "refused",
                reason: "tracker_request_budget",
                possiblyDispatched: false,
                retryAt: error.retryAt,
                retryAfterMs: Math.max(0, error.retryAt - Date.now()),
                detail: error.message,
              };
            }
          }
        }
        // Watch (ADR 0308): no tracker write by Clankie, a lead or a worker, outward or local.
        // An owner-admitted write (his own, or a post he approved) is his.
        if (
          server.id === "linear" &&
          input.posting !== TRACKER_POSTING_ADMITTED &&
          (graphqlPlan ? graphqlPlan.mutation : isTrackerWriteTool(input.tool)) &&
          (await options.settings.load()).autonomy?.watch === true
        )
          return {
            outcome: "refused",
            reason: "posting_refused",
            possiblyDispatched: false,
            detail: WATCH_REFUSAL,
          };
        // "Posting to your tracker" (ADR 0302): an outward write by Clankie or a worker passes
        // its project's setting first. A repo on private issue files or the built-in tracker,
        // and the built-in tracker standing in for Linear, stay on this Mac and pass freely.
        if (
          options.trackerPosting &&
          server.id === "linear" &&
          input.posting !== TRACKER_POSTING_ADMITTED &&
          (graphqlPlan ? graphqlPlan.mutation : isTrackerWriteTool(input.tool))
        ) {
          const repoTarget = repositoryCall
            ? await options.trackerPosting.repoTarget(trackerRepo as string)
            : undefined;
          if (!repositoryCall ? !isLocalTracker(server) : repoTarget !== undefined) {
            const args = Object.fromEntries(
              Object.entries(input.arguments).filter(([key]) => key !== "repo"),
            );
            const admission = await options.trackerPosting.admit({
              tracker: repoTarget?.tracker ?? "linear",
              route: repositoryCall
                ? {
                    kind: "repo",
                    repo: trackerRepo as string,
                    local: input.lane === "operator" && input.delegation === undefined && !inferredRepo,
                    tool: input.tool,
                    arguments: structuredClone(args),
                  }
                : { kind: "linear", tool: input.tool, arguments: structuredClone(input.arguments) },
              asker: input.delegation
                ? {
                    kind: "worker",
                    principalId: input.delegation.principalId,
                    ...(workerName === undefined ? {} : { name: workerName }),
                  }
                : {
                    kind: "lead",
                    ...(providedSource ? { conversationId: providedSource.owner.conversationId } : {}),
                  },
              ...(repoTarget?.projectIds.length
                ? { projectIds: repoTarget.projectIds }
                : input.posting !== undefined
                  ? { projectIds: [input.posting.projectId] }
                  : {}),
            });
            if (admission.outcome !== "post")
              return {
                outcome: "refused",
                reason: admission.outcome === "refused" ? "posting_refused" : "posting_held",
                possiblyDispatched: false,
                detail: admission.message,
              };
          }
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
          const client = repositoryCall || graphqlCall ? undefined : await connection(server, state, now);
          const connectedAccount =
            input.delegation !== undefined || options.observeCall !== undefined
              ? await account(server, state.credential).catch((error: unknown) => {
                  if (input.delegation !== undefined) throw error;
                  return undefined;
                })
              : undefined;
          if (input.delegation !== undefined && connectedAccount?.binding !== input.delegation.binding)
            throw new Error("Delegated account binding changed; a new grant is required");
          let graphqlAccess: { bearer: string; credential: ProviderCredential } | undefined;
          if (graphqlCall) {
            const selected = await trackerMcp!.graphql.credential(options.credentials);
            const bearer =
              selected &&
              (await resolveProviderBearer(selected.id, options.credentials, Date.now(), {
                fetch: options.linearFetch ?? fetch,
              }));
            // Budget accounting and redaction use the refreshed stored credential.
            const refreshed = selected && (await trackerMcp!.graphql.credential(options.credentials));
            if (!bearer || refreshed?.id !== selected?.id)
              return {
                outcome: "refused",
                reason: "server_unavailable",
                possiblyDispatched: false,
                detail: trackerMcp!.graphql.reconnect,
              };
            graphqlAccess = { bearer, credential: refreshed!.credential };
          }
          await assertCurrent(server, state);
          const workerPost =
            server.id === "linear" &&
            server.credential !== undefined &&
            trackerMcp?.isWorkerTool(input.tool) === true;
          const credential = workerPost ? await options.credentials.get(server.credential!) : undefined;
          const source = admittedSource;
          // Attribution is optional: losing an owning conversation does not revoke
          // independently admitted connected-account tools.
          let authority: ConversationAuthority | undefined;
          let recipient: LinearRecipient | undefined;
          const refreshAttribution = async () => {
            authority = undefined;
            recipient = undefined;
            if (!publicationCall && !input.requireConversationAttribution) return;
            if (!source && !admittedNativeSource) {
              if (input.requireConversationAttribution)
                throw new DispatchRefused("Tracker conversation attribution is unavailable");
              return;
            }
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
            if (input.requireConversationAttribution && !authority)
              throw new DispatchRefused("Tracker conversation attribution is unavailable");
          };
          // Owned publication backends reprove at their actual beforeWrite
          // boundary. Generic MCP writes need one reproof before dispatch.
          if (
            input.requireConversationAttribution ||
            (!repositoryCall && !isLocalTracker(server) && !isApiTracker(server) && !workerPost)
          )
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
              if (linearWrite) trackerReads.invalidate();
            }
          };
          // A strict READ's authority is prepared here, before the backend takes its
          // store lock; under the lock only these synchronous checks run.
          let readCurrent: (() => void) | undefined;
          let readPrepared = false;
          if (
            !repositoryCall &&
            isLocalTracker(server) &&
            input.delegation &&
            input.fence &&
            input.onReadPrepared &&
            options.localTracker?.withReadSnapshot &&
            options.localTracker.readSnapshotCandidate?.(input.tool)
          ) {
            // The READ proof is optional: when its route or account can't be fenced, the call
            // stays an ordinary unclassified read under the ordinary dispatch fences.
            const hostFence = await defaultReadFence(server, state!, input.delegation.principalId, signal, {
              tool: input.tool,
              args: input.arguments,
            }).catch((error: unknown) => {
              signal.throwIfAborted();
              options.logger.info(
                {
                  event: "mcp.read_proof.unavailable",
                  server: server.id,
                  tool: input.tool,
                  detail: error instanceof Error ? error.message.slice(0, 200) : "Read fence failed",
                },
                "Tracker read proceeds unclassified",
              );
              return undefined;
            });
            if (hostFence) {
              const receiptFence = await input.readReceiptFence?.();
              readCurrent = () => {
                receiptFence?.();
                hostFence();
                assertDispatch();
              };
              readCurrent();
            }
          }
          const publication = {
            actor: trackerActor,
            signal: input.signal === undefined ? signal : AbortSignal.any([signal, input.signal]),
            ...(readCurrent
              ? {
                  beforeRead: async () => {
                    readCurrent!();
                    return readCurrent;
                  },
                  onReadPrepared: (snapshot: import("@clankie/work-items").TrackerReadSnapshot) => {
                    readCurrent!();
                    input.onReadPrepared!({
                      ...snapshot,
                      server: "linear",
                      tool: input.tool,
                      fingerprint: createHash("sha256")
                        .update(canonicalJson([`linear_${input.tool}`, input.arguments]))
                        .digest("hex"),
                      accountBinding: connectedAccount!.binding,
                      routingArguments: z
                        .record(z.string(), z.json())
                        .parse(structuredClone(input.arguments)),
                      target: { ...snapshot.target, resourceBinding: localBinding },
                    });
                    readPrepared = true;
                  },
                }
              : {}),
            ...(input.lane === "operator" &&
            input.delegation === undefined &&
            providedSource &&
            options.prepareTrackerLeadClosure
              ? {
                  authorizeLeadClosure: (projectId: string | null) =>
                    options.prepareTrackerLeadClosure!(providedSource, projectId),
                }
              : {}),
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
              ? await options.trackerForRepo!({
                  name: input.tool,
                  repo: trackerRepo as string,
                  args: Object.fromEntries(Object.entries(input.arguments).filter(([key]) => key !== "repo")),
                  lane: input.lane,
                  local: input.lane === "operator" && input.delegation === undefined && !inferredRepo,
                  ...publication,
                }).then(
                  (value) => ({ content: JSON.stringify(value), isError: false }),
                  (error: unknown) => {
                    // A tracker read whose provider settled a refusal has a definite answer.
                    // Lost or ambiguous provider calls, and every write, keep their fences.
                    if (!(error instanceof TrackerReadRejected) || !trackerReadTool(input.tool)) throw error;
                    return { content: error.message, isError: true };
                  },
                )
              : graphqlAccess
                ? await trackerMcp!.graphql.execute({
                    plan: graphqlPlan!,
                    bearer: graphqlAccess.bearer,
                    credential: graphqlAccess.credential,
                    signal,
                    dispatch: () => {
                      notifyDispatch();
                      if (graphqlPlan!.destructive.length > 0)
                        options.logger.info(
                          {
                            event: "mcp.host.linear_graphql.destructive",
                            fields: graphqlPlan!.destructive.map((entry) => entry.field),
                            targets: graphqlPlan!.destructive.flatMap((entry) => entry.targets),
                            lane: input.lane,
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
                          "linear graphql destructive mutation dispatched",
                        );
                    },
                    ...(options.linearFetch ? { fetch: options.linearFetch } : {}),
                    ...(options.linearRequestBudget ? { requestBudget: options.linearRequestBudget } : {}),
                  })
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
                    ? await options.localTracker!.call(input.tool, input.arguments, publication).then(
                        (value) => ({ content: JSON.stringify(value), isError: false }),
                        (error: unknown) => {
                          // After the worker classified it READ, the backend's own pure read
                          // threw: that is its definite answer, not a possibly dispatched call.
                          if (!readPrepared || error instanceof DispatchRefused) throw error;
                          return {
                            content: error instanceof Error ? error.message : String(error),
                            isError: true,
                          };
                        },
                      )
                    : workerPost
                      ? await trackerMcp!.publishWorker({
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
                          ...(options.linearRequestBudget
                            ? { requestBudget: options.linearRequestBudget }
                            : {}),
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
            if (dispatched && linearWrite) trackerReads.invalidate();
            selected.activeCalls -= 1;
            // Provider settlement releases the connection; receipt observers
            // can still await without retaining an obsolete transport.
            if (selected.retired) void closeRetired(selected);
          }
          const compacted =
            input.resultMode !== "data" && server.id === "linear" && !result.isError
              ? (trackerMcp?.compactWrite(input.tool, result.content) ?? result.content)
              : result.content;
          const content = markHistory ? markLinearHistory(compacted) : compacted;
          const settled = {
            content: input.resultMode === "data" ? content : content.slice(0, MAX_RESULT_CHARACTERS),
            isError: result.isError,
          };
          const readOnly =
            !dispatched &&
            (repositoryCall || isLocalTracker(server) || isApiTracker(server) || priorityRead) &&
            trackerReadTool(input.tool);
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
            !graphqlCall &&
            !(error instanceof DispatchRefused) &&
            trackerMcp?.budgetRefusal(error) === undefined &&
            state !== undefined &&
            state.failure === undefined
          )
            await retire(server.id, state);
          const budgetRefusal = trackerMcp?.budgetRefusal(error);
          return {
            outcome: "refused",
            reason: budgetRefusal ? "linear_request_budget" : "server_unavailable",
            possiblyDispatched: dispatched,
            ...(budgetRefusal ? { retryAt: budgetRefusal.retryAt } : {}),
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
        void withinLinearRequestInvocation(
          /^(?:get|list|search|check|fetch|read)_/u.test(input.tool)
            ? (input.requestPriority ?? currentLinearRequestPriority("interactive"))
            : "interactive",
          perform,
        ).then(
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
  requestBudget?: ProviderRequestBudget,
): Promise<McpConnection> {
  const client = new Client({ name: "clankie", version: "1" }, { capabilities: {} });
  // The SDK's own transports do not satisfy its `Transport` interface under
  // `exactOptionalPropertyTypes` — their `onmessage` drops the generic and the
  // `extra` parameter the interface declares. The cast is at this one boundary
  // rather than loosening the repo's strictness for everyone.
  const transport = (await createTransport(
    server,
    credentials,
    expectedCredential,
    requestBudget,
  )) as unknown as Transport;
  try {
    await withLinearRequestPriority("interactive", () =>
      client.connect(transport, { timeout: CONNECT_TIMEOUT_MS }),
    );
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
  requestBudget?: ProviderRequestBudget,
): Promise<StdioClientTransport | StreamableHTTPClientTransport> {
  const selectedCredential = async (): Promise<ProviderCredential> => {
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
    return stored;
  };
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
    return providerCredentialBearer(await selectedCredential())!;
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
        let credential: ProviderCredential | undefined;
        if (providerId !== undefined) {
          try {
            if (googleProvider(server) !== undefined) {
              headers.set("authorization", `Bearer ${await selectedBearer()}`);
            } else {
              credential = await selectedCredential();
              headers.set("authorization", `Bearer ${providerCredentialBearer(credential)}`);
            }
          } catch (error) {
            if (dispatchFence.getStore())
              throw new DispatchRefused(
                error instanceof Error ? error.message : "Connected credential changed",
              );
            throw error;
          }
        }
        if (server.id === "linear" && requestBudget && credential)
          return requestBudget.fetch(credential, fetch, url, { ...init, headers }, dispatchFence.getStore());
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
