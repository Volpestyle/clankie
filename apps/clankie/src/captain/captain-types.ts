import type { NativeRoomHandoffExecutor } from "./native-room-handoffs.ts";
import type { VelocityDeps } from "./auto-velocity.ts";
import type { RemoteOriginReader } from "./project-mirrors.ts";
import type { HarnessSeatAdapter } from "@clankie/agent-hosts";
import { type ModelPurpose } from "@clankie/model-provider";
import type { CaptainSessionLaneV2 } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { type AgentSession, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { DeliveredFileStore } from "../delivered-files.ts";
import { type FleetProjectMembership } from "../fleet-project-membership.ts";
import type { LocalCodexRegistration } from "../local-codex-seats.ts";
import type { RemoteCodexLaunch, RemoteCodexRegistration } from "../remote-codex-seats.ts";
import type { BodyHeartbeat } from "../scheduled-update.ts";
import type { FleetResourceRuntime } from "../fleet-resource-runtime.ts";
import type { EvalSessionBoundary } from "./eval-session-boundary.ts";
import type { GrokNativeHost } from "./grok-native-host.ts";
import type { PrimeNativeHost } from "./prime-native-host.ts";
import { type HerdrCensusRunner } from "./herdr-census.ts";
import { type HerdrWatchRunner, type NativeLaunchPolicy } from "./herdr-watch.ts";
import { type RoutedSelection } from "./model.ts";
import type { createOpenCodeNativeHost } from "./opencode-native-host.ts";
import type { createPreparedNativeHost } from "./prepared-native-host.ts";
import type { RemoteOpenCodeWorkers } from "./remote-opencode-workers.ts";
import type { ProjectHireProcessProof } from "./project-hires.ts";
import { type TurnContext } from "./tools.ts";

export interface CaptainOptions {
  readonly operatorSeatMigrationHeld?: (conversationId: string) => boolean;
  /** Prototype only: one guild:channel (or dm:channel) text lane; absent disables recovery. */
  readonly durablePiRoom?: string;
  /** Rollout only (ADR 0291): `all` or comma-separated guild:channel targets answer in one loop per grant. */
  readonly roomLoop?: string;
  readonly builtInTracker?: import("@clankie/work-items").TrackerToolBackend;
  /** Current owner-selected machine ceiling, separate from Discord actor authority. */
  readonly requireMachineAccess?: (
    fleet: string | undefined,
    required: import("@clankie/protocol").MachineAccessLevel,
  ) => Promise<void | import("../machine-access.ts").MachineAccessFence>;
  /** Content-free native alert outcome; no raw provider exception or message text. */
  readonly onHealthAlertDelivery?: (result: {
    fingerprint: string;
    conversationId: string;
    outcome: "submitted" | "unavailable";
    reason: string;
  }) => void;
  /** Native room child execution, selected before admission under the original room ceiling. */
  readonly runNativeRoomHandoff?: NativeRoomHandoffExecutor;
  readonly bodyActivity?: Pick<BodyHeartbeat, "begin">;
  /** Explicit controller-created eval boundary; ordinary sessions remain unchanged. */
  readonly evalSessionBoundary?: EvalSessionBoundary;
  /** Override local harness control adapters (including deterministic test adapters). */
  readonly seatAdapters?: readonly HarnessSeatAdapter[];
  readonly grokNative?: GrokNativeHost;
  readonly primeNative?: PrimeNativeHost;
  readonly openCodeNative?: ReturnType<typeof createOpenCodeNativeHost>;
  readonly piNative?: ReturnType<typeof createPreparedNativeHost>;
  readonly remoteOpenCode?: RemoteOpenCodeWorkers;
  readonly nativeLaunchPolicy?: NativeLaunchPolicy;
  /** Machine-wide resource admission and cached fleet metadata; never project-local policy. */
  readonly fleetResources?: FleetResourceRuntime;
  /**
   * Herdr session detection for the connector (ADR 0312). When it returns true,
   * an operator message that cannot be confirmed is rediscovered once, and a
   * lead whose session was cleared or restarted in the same pane rebinds.
   * Absent means off, so existing deliveries keep the uncertain-receipt fence.
   */
  readonly connectorSessionDetection?: () => boolean;
  /** Per-actor tracker request budgets, for the connector's capacity read (ADR 0313). */
  readonly trackerRequestBudget?: () => import("@clankie/protocol/tracker-request-budget").TrackerRequestBudgetReport;
  readonly projectHireIdentity?: (
    fleet: string,
    pane: string,
  ) => Promise<ProjectHireProcessProof | undefined>;
  /** Why the last process proof for a pane was refused, in fixed words, when its observer says. */
  readonly projectHireRefusal?: (pane: string) => string | undefined;
  /** Fresh same-call display attribution only; individual steering still revalidates. */
  readonly projectHireIdentityBatch?: (
    fleet: string,
    seats: readonly { pane: string; nativeOccupantId: string | undefined }[],
  ) => Promise<ReadonlyMap<string, ProjectHireProcessProof | undefined>>;
  readonly projectHireDeliverableTrackerProject?: (deliverable: string) => Promise<string | undefined>;
  readonly projectHireTools?: (projectId: string) => Promise<readonly string[]>;
  readonly fleetHireTools?: () => Promise<readonly string[]>;
  readonly workerBridgeStatus?: (
    fleet: string,
    pane: string,
  ) => import("@clankie/protocol").WorkerBridgeStatus;
  readonly workerReportBridgeStatus?: (
    fleet: string,
    pane: string,
  ) => import("@clankie/protocol").WorkerReportBridgeStatus | undefined;
  /** The same native membership producer exposed by the HTTP app, created after the captain. */
  readonly fleetProjectMembership?: () => Pick<FleetProjectMembership, "read"> | undefined;
  readonly projectHireWorkspace?: (proof: ProjectHireProcessProof) => Promise<string | undefined>;
  readonly nativeHerdrRunner?: HerdrWatchRunner;
  readonly nativeCensusRunner?: HerdrCensusRunner;
  readonly nativeSummariesPath?: string;
  readonly fleetRoundIntervalMs?: number;
  /** Auto round cadence (ADR 0264); defaults to the fleet round's. */
  readonly autoRoundIntervalMs?: number;
  /** How long an unchanged Auto round waits before waking again. */
  readonly autoIdleRewakeMs?: number;
  /** Reads a remote-only project's origin URL for its Mac-side mirror (ADR 0270). */
  readonly remoteOrigin?: RemoteOriginReader;
  /** Reads a project's tracker outcomes for its Auto round's velocity (ADR 0270). */
  readonly projectOutcomes?: VelocityDeps["outcomes"];
  /** Ready work and explicit blockers from the project's saved tracker (VUH-2335). */
  readonly projectWorkQueue?: (
    project: import("@clankie/protocol/projects").Project,
  ) => Promise<import("@clankie/protocol/auto-rounds").AutoWorkQueue>;
  /** How long an operator head stays held after a completed poll; defaults to 30s (VUH-2045). */
  readonly headBoundGraceMs?: number;
  /** How long a head that keeps asking holds its lane between polls (VUH-2874). */
  readonly headLaneHoldMs?: number;
  /**
   * How long a routine worker report or completion waits for an idle native
   * lead's next round (VUH-2274). The service passes `REPORT_ROUND_MS`;
   * absent, each is delivered at once.
   */
  readonly reportRoundMs?: number;
  /** How often the default lead seat is considered for a fresh restart; defaults to 5 minutes (ADR 0271). */
  readonly leadRestartCheckMs?: number;
  /** How often settled hire panes are considered for automatic tidy; defaults to 5 minutes (VUH-2392). */
  readonly autoTidyPaneCheckMs?: number;
  /** How often landed worktrees are considered for automatic removal; defaults to an hour. */
  readonly autoTidyWorktreeCheckMs?: number;
  /** The fleet efficiency show/review answer deadline; defaults to 25s, under the CLI's 30s abort. */
  readonly fleetEfficiencyDeadlineMs?: number;
  /** First background reprobe of a linked fleet whose census failed; doubles to 30s. Defaults to 5s. */
  readonly fleetProbeMinMs?: number;
  readonly localCodexProcess?: (pid: number, pane: string) => LocalCodexRegistration;
  readonly localCodexSocket?: () => string | undefined;
  readonly remoteCodexProcess?: (launch: RemoteCodexLaunch) => RemoteCodexRegistration;
  /** The persona's look references, which its extension supplies (ADR 0328). */
  readonly personaLook?: PersonaLook;
  /** Repo root: instructions.md lives here, skills are discovered here. */
  readonly repoRoot: string;
  /**
   * Where his shell and sessions run when a conversation names no workspace
   * (ADR 0149). Default the operator's home directory — never the repo root,
   * which on a release install is immutable.
   */
  readonly workingDirectory?: string;
  /** Durable captain state (sessions, lane logs, conversations). Default ~/.clankie/captain. */
  readonly stateDir: string;
  /** Settings store; defaults to the owner-authored file. Reloaded per turn. */
  readonly settings?: SettingsStore;
  /** Joined machines, for Clankie's own shell there beside his local coding tools. */
  readonly joinedMachines?: import("./machine-coding-tools.ts").JoinedShellMachines;
  /** Startup extension switch; omitted preserves standalone captain behavior. */
  readonly linearWakeEnabled?: boolean;
  /** Live webhook readiness, rechecked before a queued Linear wake starts. */
  readonly linearFollowing?: () => Promise<boolean>;
  readonly linearWakeReceived?: (
    references: readonly import("./tracker-activity.ts").TrackerWakeReference[],
  ) => Promise<unknown>;
  /** Real process-level overrides captured before stored settings are projected into child env. */
  readonly discordEnvironment?: NodeJS.ProcessEnv;
  /** Conversation-scoped file publication; bytes share the conversation retention lifecycle. */
  readonly deliveredFiles?: Pick<DeliveredFileStore, "publish" | "removeConversation"> &
    Partial<Pick<DeliveredFileStore, "beginUpload" | "appendUpload" | "commitUpload" | "attachment">>;
}

/**
 * The owner's references for how Clankie looks and feels, in core shapes. The
 * persona supplies it from its mood board (ADR 0328); absent, sessions carry none.
 */
export interface PersonaLook {
  /** Whether any references are configured, so a session carries them. */
  readonly present: () => Promise<boolean>;
  /** Shows the references before each turn, with the host's current context after them. */
  readonly extension: (turnContext?: (prompt: string) => Promise<string>) => InlineExtension;
  /** Their written description for a prompt, empty when there are none. */
  readonly briefing: () => Promise<string>;
}

export interface LaneSession {
  readonly credentialRecovery?: import("./owner-credential-recovery.ts").OwnerCredentialRecovery;
  readonly session: AgentSession;
  readonly capture: TurnContext;
  /** Machine-wide skills left out of the listing; `/name` still expands them. */
  readonly quietSkills: ReadonlySet<string>;
  readonly purpose: ModelPurpose;
  /** This purpose's route as of the last sync; the routing extension reads it per run. */
  readonly route: {
    current: RoutedSelection;
    used?: import("@clankie/protocol/model-keys").TurnModelUsage;
    recorder?: import("./turn-model.ts").TurnModelRecorder;
  };
  /** Set when a request had to be trimmed to fit; the next sync compacts first. */
  readonly budget: { compactBeforeNextRun: boolean };
  /** The lane's service-tool gate: tools withheld until their service is set up (VUH-2647). */
  readonly serviceTools: { readonly lane: CaptainSessionLaneV2; readonly withheld: Set<string> };
  lastAssistantText: string;
  turnCounter: number;
  /** Settlement of the in-flight run, while one is active: true if it succeeded. */
  running?: Promise<boolean> | undefined;
  runningDeliveryId?: string | undefined;
  /**
   * Operator turns hold this while they prepare (model sync, lane-log, herdr
   * census) so a concurrent human send waits and then steers instead of starting
   * a second prompt.
   */
  starting?: Promise<void> | undefined;
}

/**
 * The slice of pi's agent state a settled run is judged on. Kept structural so
 * a turn only ever asks for the transcript it reads.
 */
export interface PiRunState {
  readonly messages: readonly {
    readonly role: string;
    readonly stopReason?: string | undefined;
    readonly errorMessage?: string | undefined;
  }[];
}
