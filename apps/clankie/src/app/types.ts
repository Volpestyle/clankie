import type { HarnessRefreshAuthority } from "../runtime-update-routes.ts";
import type { InstalledGameExtensions } from "../game-extension-projection.ts";
import type { HerdrFleet } from "../herdr-fleet.ts";
import type { FleetHealthMetrics } from "../fleet-health-metrics.ts";
import type { BodyTelemetry } from "@clankie/observability/body-telemetry";
import type { IntegrationQueue } from "../integrate.ts";
import type { DeployHolds } from "../deploy-holds.ts";
import { DiscordVoiceTranscriptStore } from "@clankie/discord-presence-core";
import {
  type ActivityObservationSnapshot,
  type DiscordPresenceSessionRecord,
  type DiscordVoiceStay,
  type PlayStillRead,
  type PlayStoryRead,
} from "@clankie/interactive-environment";
import type { DiscordStreamWatchObservation } from "@clankie/protocol";
import {
  type BrowserToolCatalog,
  type CallBrowserToolRequest,
  type CallBrowserToolResult,
  type CaptainSessionLaneV2,
  type DeviceGrantSet,
  type DiscordTransportKind,
  type HerdrBinding,
} from "@clankie/protocol";
import type { HostPowerReport } from "@clankie/protocol/host-power";
import { type PublicGatewayDoorwayState } from "@clankie/protocol/public-gateway";
import { type ClankieSettings } from "@clankie/settings";
import { Hono } from "hono";
import type { AccountsPort } from "../accounts.ts";
import type { AgentSessions } from "../agent-sessions.ts";
import type { BodyLeaseRouter } from "../body-lease-router.ts";
import type { BodyLeaseStore } from "../body-leases.ts";
import type { BodyPlaySessions } from "../body-play-sessions.ts";
import type { BodyVoiceStays } from "../body-voice-stays.ts";
import { CaptainPresenceManager } from "../captain-presence.ts";
import { DiscordTurnReceipts } from "../captain/discord-turn-receipts.ts";
import { type CaptainPort } from "../captain/port.ts";
import type { ComputerUseHarness } from "../computer-use-harnesses.ts";
import type { DeliveredFileStore } from "../delivered-files.ts";
import type { ActivitySharing } from "../activity-sharing.ts";
import { type DiscordIngressPort } from "../discord-ingress.ts";
import type { DiscordPresenceRuntimePort } from "../discord-presence-runtime.ts";
import type { DiscordRoomObservations } from "../discord-room-observations.ts";
import type { DiscordRoomVoice } from "../discord-room-voice.ts";
import { EmbodimentManager } from "../embodiment.ts";
import { type ExecutionConnections } from "../herdr-session.ts";
import type { HostedBodyClient } from "../hosted-body.ts";
import type { ComposerTranscriptions } from "../composer-transcription.ts";
import type { HostedDeviceSecurity } from "../hosted-device-security.ts";
import type { HostedDiscordOperator } from "../hosted-discord.ts";
import type { HostedPairing } from "../hosted-pairing.ts";
import { type LinearActivityEvent, type LinearWriteReceipts } from "../linear-webhook.ts";
import type { MediaGeneratorPort } from "../media-generation.ts";
import type { ManagedDiscord } from "../managed-discord.ts";
import { type MemoryStores } from "../memory.ts";
import type { MinecraftService } from "../minecraft.ts";
import type { ModelKeysPort } from "../model-keys.ts";
import { pairingOfferWire, type PairingOfferRecord, type StoredPairingOffer } from "../pairing.ts";
import type { PersonaImageSource } from "../persona-images.ts";
import { type PushWakeSender } from "../push.ts";
import type { RuntimeProvider } from "../runtime-provider.ts";
import { type VoiceSpeechSnapshot } from "../voice-receipt-activity.ts";
import { type WorkItemsService } from "../work-items.ts";
import { type WorkerMcp } from "../worker-mcp.ts";
/**
 * A redeemed-but-not-yet-completed pairing, held in memory only (single-use,
 * ~10 min). A restart drops these, so an in-flight pairing must restart —
 * fail closed, same as an outstanding offer.
 */
export interface PendingCompletion {
  deviceId: string;
  offeredGrants: DeviceGrantSet;
  expiresAtMs: number;
  consumed: boolean;
  reissue?: true;
  authorizedByBrowserSession?: string;
}

// ---------------------------------------------------------------------------
// Injected in-process capability ports.
// ---------------------------------------------------------------------------

interface ActivityObservationReadPort {
  current(signal?: AbortSignal): Promise<ActivityObservationSnapshot | undefined>;
}

interface BrowserToolPort {
  catalog(signal?: AbortSignal): Promise<BrowserToolCatalog>;
  call(
    request: CallBrowserToolRequest,
    signal?: AbortSignal,
    authority?: { shell?: boolean; guard?: () => Promise<void>; conversationId?: string },
  ): Promise<CallBrowserToolResult>;
}

// ---------------------------------------------------------------------------
// Authentication contracts.
// ---------------------------------------------------------------------------

export interface TrustedCaptainIdentity {
  captainId: string;
  /** Exact host-admitted source; a bearer or request body alone cannot establish it. */
  episodeSource?: {
    readonly conversationId: string;
    readonly lane: CaptainSessionLaneV2;
    readonly targetId: string;
    readonly sessionId: string;
  };
  /** Server-authenticated origin; request bodies cannot elevate it. */
  steerSourceLane?: "discord_text" | "discord_voice" | "api";
  /** Which Discord body this bearer speaks for. Defaults to `bot`. */
  discordTransportKind?: DiscordTransportKind;
}
type CaptainAuthenticator = (request: Request) => Promise<TrustedCaptainIdentity | undefined>;

export interface TrustedOperatorIdentity {
  operatorId: string;
  steerSourceLane?: "tui" | "api";
}
export type OperatorAuthenticator = (request: Request) => Promise<TrustedOperatorIdentity | undefined>;

interface PairingOfferPublisher {
  protectPairingOffer?(offer: StoredPairingOffer): ReturnType<typeof pairingOfferWire>;
  publishPairingOffer(offer: StoredPairingOffer): Promise<void>;
  /** Re-register a review offer's route after a restart (ADR 0154); no acknowledgment awaited. */
  restorePairingRoute?(route: PairingOfferRecord): void;
}

export interface TrustedDeviceIdentity {
  deviceId: string;
  grants: DeviceGrantSet;
  sessionExpiresAt: string;
}
export type DeviceAuthDenial = { denied: "expired" | "revoked" | "invalid" };

export interface ClankieAppDependencies {
  skinDrafts?: import("../skin-drafts.ts").SkinDraftService;
  /** Host-side voice environment validation; omitted uses the service process environment. */
  voiceSettingsEnv?: NodeJS.ProcessEnv;
  fleetResources?: import("../fleet-resource-runtime.ts").FleetResourceRuntime;
  remoteFleetResources?: import("../machine-fleet-resources.ts").RemoteFleetResourceHost;
  /** The owner's view specs (VUH-2035). */
  views?: import("../views.ts").ViewStore;
  integration?: IntegrationQueue;
  deployHolds?: DeployHolds;
  runtimeUpdater?: import("../../../tui/bin/runtime-updater.ts").RuntimeUpdater;
  scheduledReleaseCutover?: Parameters<
    typeof import("../runtime-update-routes.ts").createRuntimeUpdateRoutes
  >[0]["scheduledCutover"];
  runtimeCanary?: import("../runtime-canary.ts").RuntimeCanary;
  /** Owner transfer routes and the self record `/health` reports (ADR 0286). */
  bodyTransfer?: {
    readonly transfer: import("../body-transfer.ts").BodyTransfer;
    /** An active body freezes and applies through a cutover; a dormant one has none. */
    readonly cutover?: import("../body-transfer.ts").BodyCutover;
    /** A dormant body restarts so boot applies what it committed. */
    readonly restart?: () => void;
  };
  /** Set only on a dormant body: the routes its doorway admits (ADR 0286, VUH-2583). */
  admit?: (method: string, path: string) => boolean;
  refreshHarnesses?: (authority: HarnessRefreshAuthority) => Promise<unknown>;
  pluginVersionInstalled?: (version: string) => void;
  refreshWorkerCatalogs?: import("../worker-tool-refresh.ts").RefreshWorkerCatalogs;
  discordIngress?: DiscordIngressPort;
  /** The free official bot on a self-hosted machine (VUH-1766): live status and on/off. */
  officialDiscord?: import("../discord-room-routes.ts").DiscordRoomRoutesOptions["officialBot"];
  /** Durable exact Discord turn receipts; production supplies its state directory. */
  discordTurnReceiptPath?: string;
  /** Durable operator MCP hire/delivery receipts, retained across service restarts. */
  seatCallReceiptPath?: string;
  discordTurnReceipts?: DiscordTurnReceipts;
  modelKeys?: ModelKeysPort;
  /** Worker harness sign-in with each harness's own login (Claude, Codex). */
  captainSeats?: import("../captain-seat.ts").CaptainSeats;
  harnessLogins?: import("../harness-logins.ts").HarnessSignIns;
  /** Proven by the primary listener socket, never a caller-supplied header. */
  isLocalCompanionRequest?: (request: Request) => boolean;
  /** Owner identity proven only by the private same-user Unix mint listener. */
  localCompanionOwner?: (request: Request) => TrustedOperatorIdentity | undefined;
  /** A native client on this Mac over loopback, not forwarded by the gateway; picks addresses only. */
  isSameMacRequest?: (request: Request) => boolean;
  /**
   * Proves which app on this Mac sent a companion redeem and whether the owner
   * trusts it (VUH-2604). Absent means no app is trusted: every redeem is refused.
   */
  verifyLocalCompanionApp?: (
    request: Request,
  ) => Promise<import("../companion-app-identity.ts").CompanionAppVerdict>;
  modelDeviceSetup?: { platform: NodeJS.Platform; hosted: boolean };
  /** The owner's GitHub and Linear account connections (ADR 0196). */
  accounts?: AccountsPort;
  hostedPairing?: HostedPairing;
  hostedDiscordOperator?: HostedDiscordOperator;
  managedDiscord?: ManagedDiscord;
  onHostedPairing?: () => void;
  hostedBody?: Pick<HostedBodyClient, "registerWakeKey" | "revokeWakeKey">;
  supportGrantSync?: Pick<HostedBodyClient, "syncSupportGrants">;
  /** Host-readable grant metadata for the hosted shell watcher (`CLANKIE_SUPPORT_GRANTS_FILE`). */
  supportGrantsFile?: string;
  /** Mandatory support audit bypasses ordinary diagnostic consent. */
  supportTelemetry?: BodyTelemetry;
  /** Tenant telemetry key or a dedicated random key persisted on this body volume. */
  supportDeviceRefKey?: Uint8Array;
  composerTranscriptions?: ComposerTranscriptions;
  /** Evidence blobs and records (ADR 0258). */
  evidenceStore?: import("../evidence-store.ts").EvidenceStore;
  /** The built-in tracker, for the owner's own authenticated writes (VUH-1917). */
  builtInTracker?: import("@clankie/work-items").LocalTrackerBackend;
  /** Forums bound as two-way views of built-in tracker projects (VUH-2531). */
  discordForum?: {
    receive(event: import("@clankie/protocol").DiscordForumEventRequest): Promise<"accepted" | "not_bound">;
  };
  /** Owner project-binding validation through the connected Linear app, never a fallback. */
  linearProjectExists?: (id: string) => Promise<boolean>;
  importLinear?: (projectId: string, scratch: string, assertCurrent: () => Promise<void>) => Promise<unknown>;
  /** Owner command for a scratch store's webhook mirror (VUH-1965). */
  linearMirrors?: Pick<import("../linear-mirror.ts").LinearMirrors, "configure">;
  /** Mirror 3 (VUH-1987): owner-run cutover from Linear and its switch-back. */
  linearCutover?: Pick<import("../linear-cutover.ts").LinearCutover, "run">;
  /** Optional host policy; ordinary installations do not supply a provider. */
  runtimeProvider?: RuntimeProvider;
  accountSettings?: Pick<HostedBodyClient, "readAccountSettings">;
  hostedDeviceSecurity?: Pick<HostedDeviceSecurity, "prepare" | "revokeDevice"> &
    Partial<Pick<HostedDeviceSecurity, "publishSupportDevice" | "publishOwnerDevice" | "isRevoked">>;
  /** Any Claude/Codex/Grok/Pi transcript here or on an owner-configured SSH host. */
  agentSessions?: AgentSessions;
  /** Work items in each repo's own tracking convention (ADR 0191). */
  workItems?: WorkItemsService;
  /** Media embedded in returned work items, resolved to evidence blobs (VUH-2666). */
  workMedia?: Pick<import("../work-media.ts").WorkMedia, "observe" | "resolve">;
  workerMcp?: WorkerMcp;
  fleetHealthMetrics?: Pick<FleetHealthMetrics, "snapshot">;
  linearRequestBudget?: Pick<import("../linear-request-budget.ts").LinearRequestBudget, "report">;
  /** The Auto round record (ADR 0270), read by `clankie auto rounds`. */
  autoRounds?: Pick<import("../captain/auto-rounds.ts").AutoRoundRecord, "read">;
  runtimes?: ExecutionConnections;
  machineJoins?: import("../machine-joins.ts").MachineJoins;
  /** Optional execution health; failure does not make the captain unhealthy. */
  herdrRuntime?: () => string | undefined;
  /** Only a currently available connection has an active binding. */
  herdrBinding?: () => HerdrBinding | undefined;
  /** What the public doorway is doing, so `/health` can say the phone cannot reach him. */
  publicGatewayDoorway?: () => PublicGatewayDoorwayState;
  /** Whether this host may sleep, and when it last did, so the app can say why he went quiet. */
  hostPower?: () => HostPowerReport;
  autoUpdateManaged?: boolean;
  applyKeepAwake?: () => Promise<void>;
  keepAwakeStatus?: () => Promise<
    NonNullable<import("@clankie/protocol/owner-settings").HostSettingsSnapshot["keepAwakeService"]>
  >;
  credentialStoreHealth?: () => import("@clankie/credential-broker").CredentialStoreHealth;
  runtimeHealth?: () => import("@clankie/protocol").RuntimeHealthObservation;
  /** The pi captain seam. Tests pass `createStubCaptain()`. */
  captain: CaptainPort;
  remoteProjectLeads?: import("../remote-project-leads.ts").RemoteProjectLeads;
  /**
   * Linked ssh fleets (VUH-1527): a link token's fleet. That token may use the
   * fleet seat routes for that fleet's panes and nothing else.
   */
  fleetLinks?: {
    authenticate(token: string): string | undefined;
    identity?(request: Request): import("../local-fleet-link.ts").LocalFleetIdentity | undefined;
  };
  /** Which process may act as the lead's operator-lane bridge or controller for a conversation (VUH-2816). Absent, the operator lane refuses every bridge. */
  operatorSeatBindings?: import("../operator-seat-bindings.ts").OperatorSeatBindings;
  operatorSeatInventory?: () => ReturnType<
    typeof import("../operator-seat-inventory.ts").operatorSeatInventory
  >;
  operatorSeatMigrations?: import("../operator-seat-migrations.ts").OperatorSeatMigrations;
  localFleet?: {
    identity(request: Request): import("../local-fleet-link.ts").LocalFleetIdentity | undefined;
  };
  fleetProjectMembership?: Pick<import("../fleet-project-membership.ts").FleetProjectMembership, "read">;
  projectWorktreeRoot?: import("@clankie/settings").ObserveProjectWorktreeRoot;
  /** `clankie herdr prepare NAME`: prepare native workers through that fleet's registered transport. */
  prepareFleet?: (id: string, options: { codexSourceSetup?: string }, fleet: HerdrFleet) => Promise<unknown>;
  prepareLocalClaudeShim?: (action: "install" | "remove", binding: HerdrBinding) => Promise<unknown>;
  inspectFleetHarnesses?: (id: string) => Promise<unknown>;
  /** A machine's worker accounts (VUH-1527); absent fleet is this machine. */
  workerAccounts?: (
    fleet?: string,
    harnesses?: readonly import("../captain/harness-accounts.ts").WorkerAccountHarness[],
  ) => Promise<import("../captain/harness-accounts.ts").MachineWorkerAccounts>;
  /** Host-only project eligibility on a configured fleet; never verifies an MCP connection. */
  inspectFleetMembership?: (
    id: string,
  ) => Promise<import("@clankie/protocol/projects").FleetMembershipReport>;
  /** Exact conversation-scoped artifact bytes; publication and retention live with the captain. */
  deliveredFiles?: Pick<DeliveredFileStore, "read">;
  /** Local owner-authorized projection of delivered artifacts; hosted launch/admission is separate. */
  activitySharing?: ActivitySharing;
  /**
   * Self-hosted official Activity admission (VUH-2833). Only the local activity
   * server reaches it, presenting the broker-held activity producer bearer.
   */
  activityAdmission?: {
    token(): Promise<string | undefined>;
    admit(input: unknown): Promise<import("../activity-admission.ts").SelfHostedActivityAdmission>;
  };
  /** Records the bot's own Activity launches so admission serves only those channels. */
  activityLaunches?: {
    allowsLaunch(idempotencyKey: string): boolean;
    beginLaunch(idempotencyKey: string, guildId: string, channelId: string): () => void;
    hasNewerLaunch(guildId: string, channelId: string, except: string): boolean;
    launched(guildId: string, channelId: string): void;
    stopped(guildId: string, channelId: string): Promise<void>;
  };
  hostedActivity?: Pick<HostedBodyClient, "bootstrap" | "keys" | "revalidateActivity">;
  memory?: MemoryStores;
  personaImages?: PersonaImageSource;
  /** Owner-authored persona source for the realtime voice briefing (ADR 0057). */
  discordEnvironment?: NodeJS.ProcessEnv;
  discordDirectory?: import("../discord-room-routes.ts").DiscordRoomRoutesOptions["directory"];
  discordPermissions?: import("../discord-room-routes.ts").DiscordRoomRoutesOptions["permissions"];
  discordTestPost?: import("../discord-room-routes.ts").DiscordRoomRoutesOptions["testPost"];
  roomObservations?: DiscordRoomObservations;
  roomVoice?: DiscordRoomVoice;
  settings?: {
    load(): Promise<ClankieSettings>;
    update?(
      mutate: (current: ClankieSettings) => ClankieSettings,
      guard?: () => Promise<void>,
    ): Promise<ClankieSettings>;
  };
  discordPresenceRuntime?: DiscordPresenceRuntimePort;
  discordUserPresenceRuntime?: DiscordPresenceRuntimePort;
  activityObservations?: ActivityObservationReadPort;
  /** Activated by the first play join or authorized observation, never by boot. */
  startPlayHost?: () => Promise<void>;
  /** Live still and journal story of the asked playthrough (ADR 0099). */
  playSight?: { still(): PlayStillRead; story(): PlayStoryRead };
  browserTools?: BrowserToolPort;
  resolveBodyVoiceTarget?: (input: {
    guildId: string;
    actorId: string;
    publishChannelId?: string;
  }) => Promise<import("@clankie/protocol").BodyVoiceTarget | undefined>;
  bodyVoiceStays?: BodyVoiceStays;
  bodyPlaySessions?: BodyPlaySessions;
  guidePokemonPlay?: (
    text: string,
    identity: import("../body-lease-router.ts").BodyConversationIdentity | undefined,
  ) => Promise<unknown>;
  gameExtensions?: Pick<InstalledGameExtensions, "catalog" | "projections">;
  minecraft?: MinecraftService;
  minecraftHost?: import("../minecraft-host.ts").MinecraftHostService;
  minecraftPrivateDelivery?: Pick<
    ReturnType<typeof import("../minecraft-host-invite.ts").createMinecraftPrivateDeliveryClient>,
    "authorize"
  >;
  computer?: import("../computer-body.ts").ComputerBody;
  joinedComputer?: import("../joined-computer.ts").JoinedComputer;
  /**
   * Device voice calls (VUH-2682). Resolves the same realtime provider
   * composition and credentials a Discord body uses, when a call starts;
   * undefined means voice is not set up on this host.
   */
  voiceCall?: {
    realtime(): Promise<
      | {
          readonly ports: import("@clankie/discord-presence-core").DiscordVoiceRealtimePorts;
          readonly decayWindowMs: number;
        }
      | undefined
    >;
    /** Ends a call whose device stopped sending anything; tests shorten it. */
    readonly silentPeerMs?: number;
  };
  bodyLeases?: {
    router: BodyLeaseRouter;
    store: BodyLeaseStore;
    confirmStopped(
      resource: import("@clankie/protocol").BodyResource,
      guard: () => Promise<void>,
    ): Promise<boolean>;
  };
  /**
   * Configured computer-use harnesses here and on Windows fleets (ADR 0199).
   * Absent on a hosted body; the route then answers an empty list.
   */
  computerUseHarnesses?: { refresh(): Promise<readonly ComputerUseHarness[]> };
  mediaGenerator?: MediaGeneratorPort;
  /** Private exact Discord transcript log, injected by tests when needed. */
  voiceTranscriptStore?: DiscordVoiceTranscriptStore;
  authenticateCaptain?: CaptainAuthenticator;
  authenticateOperator?: OperatorAuthenticator;
  /** HMAC key (≥32 bytes) signing device session tokens; absent fails pairing closed (503). */
  deviceSessionKey?: Uint8Array;
  /** Optional ADR 0151 carrier. When configured, every displayed offer is published before use. */
  pairingOfferPublisher?: PairingOfferPublisher;
  /**
   * Outbound wake channel for devices that authorized push delivery (ADR 0159).
   * Absent means no gateway is configured: pairing and chat are unaffected and
   * a sleeping device simply catches up when it next opens.
   */
  pushWake?: PushWakeSender;
  /**
   * The broker-held Linear webhook signing secret (ADR 0165). Absent means no
   * webhook is configured and the route reports itself unavailable; the wake it
   * leads to belongs to the captain.
   */
  linearWebhook?: {
    secret(): Promise<string | undefined>;
    writes?: LinearWriteReceipts;
    recordActivity?(activity: LinearActivityEvent): void;
    /** His own verified Linear identity; activity it authors is kept without a wake. */
    ownAccount?(): Promise<{ userId: string; workspaceId: string } | undefined>;
    /** Bounded read of missing issue context through the verified connected account. */
    issueContext?(activity: LinearActivityEvent): Promise<LinearActivityEvent["issueContext"]>;
    projectContext?(activity: LinearActivityEvent): Promise<LinearActivityEvent["projectContext"]>;
    /** Owner-enabled Linear mirrors (VUH-1965): applied after the response, never gating a wake. */
    mirror?(event: import("@clankie/work-items").LinearMirrorEvent): void;
  };
  /** Host-scoped public base returned at redeem and used as the paired relay origin. */
  publicGatewayHostBaseUrl?: string;
  hostDisplayName?: string;
  captainLeaseDurationMs?: number;
  captainHeartbeatRecordIntervalMs?: number;
  clock?: () => Date;
  idFactory?: () => string;
  /**
   * Durable JSONL event log. Devices, pairing, the user-session opt-in, and
   * Discord presence phases replay from it on boot. Absent (tests) the log is
   * memory-only and nothing survives restart.
   */
  eventLogPath?: string;
}

export interface ClankieApp {
  app: Hono;
  /** In-process embodiment authority; the play host claims from it directly. */
  embodiment: EmbodimentManager;
  captainPresence: CaptainPresenceManager;
  /** Read views the captain's get_self_state tool assembles its card from. */
  presenceSessions: () => DiscordPresenceSessionRecord[];
  streamWatch: () => DiscordStreamWatchObservation;
  voiceHistory: (limit: number) => DiscordVoiceStay[];
  recentVoiceSpeech: (limit: number) => Promise<VoiceSpeechSnapshot>;
  conversationBodyRouteAuthorized(
    owner: import("../captain/conversation-owner.ts").ConversationOwner,
  ): boolean;
  stopBodyRequests(): Promise<void>;
  close(): Promise<void>;
}
