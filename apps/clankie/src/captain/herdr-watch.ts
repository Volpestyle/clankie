import {
  type HerdrWatchEnd,
  type HerdrWatchSettlement,
  PersistedHerdrWatchesSchema,
  type HerdrWatchRecord,
  type PersistedHerdrWatches,
  type HerdrAgentSnapshot,
  type SpawnOperatorSeat,
  type HerdrWatchRunner,
  type HerdrWatchArmResult,
  type RestartSeat,
  type HerdrWatchPort,
  type HireAuthority,
  type AdoptHire,
  type InternalWake,
  type ProjectSeat,
  RETRY_ADMISSION_MS,
  QUESTION_REMINDERS,
  SEAT_TRANSCRIPT_TAIL_MS,
  SEAT_SESSION_RETRIES,
  SEAT_SESSION_RETRY_MS,
  SEAT_PICKUP_WAIT_MS,
  type HerdrSeatSpawnResult,
  type HerdrSeatSpawnFailure,
  type HerdrSeatMoveResult,
  type PiSeatModel,
  type NativeLaunchPolicy,
  type ProjectHirePolicy,
} from "./herdr-watch-types.ts";
import { spawnFailureReason } from "./herdr-watch-helpers.ts";
import type { HerdrWatchContext } from "./herdr-watch-context.ts";
import { createHerdrWatchDelivery } from "./herdr-watch-delivery.ts";
import { createHerdrWatchQuestions } from "./herdr-watch-questions.ts";
import { createHerdrWatchOwnership } from "./herdr-watch-ownership.ts";
import { createHerdrWatchHiring } from "./herdr-watch-hiring.ts";
import { createHerdrWatchRecovery } from "./herdr-watch-recovery.ts";
import { createHerdrWatchLaunch } from "./herdr-watch-launch.ts";
import { createHerdrWatchLifecycle } from "./herdr-watch-lifecycle.ts";
import { createHerdrWatchObservation } from "./herdr-watch-observation.ts";
import { createHerdrWatchRunner } from "./herdr-watch-runner.ts";
import type { SeatExitGuard } from "@clankie/agent-hosts";
import {
  HiredSeatRestarts,
  type HiredRestartCandidate,
  type HiredRestartReceipt,
} from "./hired-seat-restart.ts";
import type {
  StopNativeTaskResult,
  FleetSeatInputCapabilities,
  FleetSeatMessageReceiver,
} from "@clankie/protocol";
import { type FleetResourceRuntime } from "../fleet-resource-runtime.ts";
import { createGithubOriginReader } from "./github-origin.ts";
import {
  ProjectHires,
  ProjectHireProcessProofSchema,
  type AttemptCandidate,
  type AttemptLaunch,
  type AttemptMerge,
  type AttemptSettlement,
  type ProjectHireProcessProof,
} from "./project-hires.ts";
import type { RetirementGuard } from "./retirement-guard.ts";
import { HireOwners, type HireStarter } from "./hire-owners.ts";
import { type ConversationAuthority, type ConversationOwner } from "./conversation-owner.ts";
import { type DiscordWatchOrigin } from "./conversation-owner.ts";
import { DeliveryFence, type UncertainReceipt } from "./delivery-fence.ts";
import { type ExternalCodexControl } from "./external-codex-control.ts";
import { createFleetSeatControl, isMessageableSeat } from "./fleet-seat-control.ts";
import { HERDR_CORE_FLEET } from "./herdr-core-runner.ts";
import { type PeerDeliveryOptions } from "./peer-seat-messages.ts";
import type { MachineAccessFence } from "../machine-access.ts";
import type { SavedAgentSession } from "../agent-sessions.ts";
import type { HarnessSeatAdapter, SeatQuestion, SeatQuestionAnswer, SeatRef } from "@clankie/agent-hosts";
import { codexAccounts, type CodexAccount } from "@clankie/settings";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  type OperatorFleetSeat,
  type HireProfile,
  type SpawnOperatorSeat as HireRequest,
} from "@clankie/protocol";
import { occupantIdForHerdrSession, type ObservedFleetSeat } from "./herdr-census.ts";
import { type FleetSeatDelivery } from "./fleet-seat.ts";
import { herdrSummariesPath, readHerdrSummariesFile, type HerdrAgentSummary } from "./herdr-summaries.ts";
import type { RemoteHireClaim, RemoteHireReceipts } from "../remote-hire-receipts.ts";
import {
  type MachineWorkerAccounts,
  type WorkerAccountHarness,
  type WorkerAccountHold,
} from "./harness-accounts.ts";
import type { HireReceiptSettlement, HireRecoveryEvidence } from "@clankie/protocol";
import { type WorkerSandbox } from "../worker-sandbox.ts";
import { type HerdrSeatTranscript } from "./herdr-transcript.ts";
export type { HerdrWatchWakeContext } from "./herdr-watch-types.ts";
export { HerdrWatchWakeAbandonedError } from "./herdr-watch-types.ts";
export type { HerdrWatchSettlement } from "./herdr-watch-types.ts";
export type { HerdrAgentSnapshot } from "./herdr-watch-types.ts";
export type { HerdrBoundPane } from "./herdr-watch-types.ts";
export type { HerdrWatchRunner } from "./herdr-watch-types.ts";
export type { HerdrWatchArmResult } from "./herdr-watch-types.ts";
export type { RestartSeat } from "./herdr-watch-types.ts";
export type { HerdrWatchPort } from "./herdr-watch-types.ts";
export { isHerdrWorkspaceMissing } from "./herdr-watch-helpers.ts";
export type { HerdrSeatSpawnResult } from "./herdr-watch-types.ts";
export type { HerdrSeatMoveResult } from "./herdr-watch-types.ts";
export type { PiSeatModel } from "./herdr-watch-types.ts";
export type { NativeLaunchPolicy } from "./herdr-watch-types.ts";
export type { ProjectHirePolicy } from "./herdr-watch-types.ts";
export { distillHerdrSeatReply } from "./herdr-watch-helpers.ts";
export {
  HerdrAgentResponseError,
  parseHerdrAgentResult,
  parseHerdrForegroundProcessId,
  parseHerdrPaneList,
  createHerdrWatchRunner,
} from "./herdr-watch-runner.ts";
export type { DiscordWatchOrigin } from "./conversation-owner.ts";

export class HerdrWatchStore implements HerdrWatchPort {
  private readonly delivery: ReturnType<typeof createHerdrWatchDelivery>;
  private readonly questions: ReturnType<typeof createHerdrWatchQuestions>;
  private readonly ownership: ReturnType<typeof createHerdrWatchOwnership>;
  private readonly hiring: ReturnType<typeof createHerdrWatchHiring>;
  private readonly recovery: ReturnType<typeof createHerdrWatchRecovery>;
  private readonly startup: ReturnType<typeof createHerdrWatchLaunch>;
  private readonly lifecycle: ReturnType<typeof createHerdrWatchLifecycle>;
  private readonly observation: ReturnType<typeof createHerdrWatchObservation>;

  public efficiency?: import("./fleet-efficiency-tools.ts").FleetEfficiencyActions;
  public restartSeat?: RestartSeat;
  public workerAccountsReport?: (fleet?: string) => Promise<MachineWorkerAccounts>;
  public huddles?: import("./port.ts").HuddleService;
  public workerAsks?: import("./worker-asks.ts").WorkerAskService;
  /** The standing review gate (ADR 0287), for the lead's waiver tool. */
  public reviews?: import("./review-gate.ts").ReviewGate;
  public routines?: NonNullable<HerdrWatchPort["routines"]>;
  private readonly projectHires: ProjectHires;
  private readonly fleetHireTools: (() => Promise<readonly string[]>) | undefined;
  private readonly projectPolicy: ProjectHirePolicy | undefined;
  private projectPolicyQueue = Promise.resolve();
  private readonly hireDefaultPolicies = new WeakMap<SpawnOperatorSeat, string>();
  /** Why Clankie chose this hire's harness, when no layer named one (VUH-1974). */
  private readonly workHires = new WeakSet<SpawnOperatorSeat>();
  private readonly hireHarnessReasons = new WeakMap<SpawnOperatorSeat, string>();
  private readonly projectAllocations = new WeakMap<SpawnOperatorSeat, string>();
  private readonly activeProjectHires = new Set<string>();
  private readonly projectRecoveryOnly = new WeakMap<SpawnOperatorSeat, string>();
  /** Age floor for receipts and allocations that predate a recorded start time. */
  private readonly loadedAt = Date.now();
  private readonly projectLiveReuse = new WeakSet<SpawnOperatorSeat>();
  private readonly projectContexts = new WeakMap<
    SpawnOperatorSeat,
    { projectId: string; projectName: string; authority?: ConversationAuthority }
  >();
  private readonly hireRefusal: ((input: HireRequest) => Promise<string | undefined>) | undefined;
  private readonly piSeatModel: (() => Promise<PiSeatModel | undefined>) | undefined;
  private readonly hireCapacity:
    | (() => Promise<{ readonly live: number; readonly limit: number } | undefined>)
    | undefined;
  private readonly remoteWorkspace: ((fleet: string, directory: string) => Promise<boolean>) | undefined;
  private readonly path: string;
  /** Where hire briefs that go by file live: `<stateDir>/claude-briefs` (#615). */
  private readonly briefStateDir: string | undefined;
  private readonly hireReceipts: DeliveryFence;
  private readonly hireOwners: HireOwners;
  private readonly hiredRestarts: HiredSeatRestarts;
  private readonly validateOwner: ((owner: ConversationOwner) => Promise<boolean>) | undefined;
  private readonly onReadopted:
    | ((seat: { occupantId: string; title: string; harness: string; name?: string }) => void)
    | undefined;
  private readonly activeHires = new Set<string>();
  private readonly remoteHireReceipts: RemoteHireReceipts | undefined;
  private readonly channelReceipt:
    | ((id: string) => Promise<
        | {
            seatId: string;
            receipt: UncertainReceipt;
            acknowledged: boolean;
            settle(evidence: HireRecoveryEvidence): void;
          }
        | undefined
      >)
    | undefined;
  private readonly remoteLaunches = new Set<string>();
  private readonly runner: HerdrWatchRunner;
  private readonly piNativeEnabled: (() => Promise<boolean>) | undefined;
  private readonly seatAdapters: ReadonlyMap<string, HarnessSeatAdapter>;
  private readonly remoteSeatAdapters:
    | ((fleet: string) => ReadonlyMap<string, HarnessSeatAdapter> | undefined)
    | undefined;
  private readonly seatControl: ReturnType<typeof createFleetSeatControl>;
  private readonly skillBundle: { repoRoot: string; stateDir: string } | undefined;
  private readonly controllers = new Map<string, AbortController>();
  private readonly seatControllers = new Map<string, AbortController>();
  private readonly seatStatuses = new Map<string, string>();
  private readonly seatSummaries = new Map<string, string>();
  private readonly transcriptSeats = new Set<string>();
  private readonly headSeats = new Set<string>();
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly summariesPath: string;
  private readonly summaryWatchIntervalMs: number;
  private readonly seatTranscriptTailMs: number;
  private readonly lastReply: ((agent: HerdrAgentSnapshot) => Promise<string | undefined>) | undefined;
  private readonly awaitRound: ((conversationId: string, signal: AbortSignal) => Promise<void>) | undefined;
  private readonly questionReminders: {
    readonly retryMs: number;
    readonly remindMs: number;
    readonly windowMs: number;
  };
  private state: PersistedHerdrWatches;
  private wake: InternalWake | undefined;
  /** Host policy resolution and escalation reuse the owner's ask store. */
  public watching: (() => Promise<boolean>) | undefined;
  public permissionLeadAllowed: ((owner: ConversationOwner) => Promise<boolean>) | undefined;
  public questionGate:
    | ((agent: HerdrAgentSnapshot, question: SeatQuestion) => Promise<"allow" | "lead" | "owner">)
    | undefined;
  public escalateQuestion:
    | ((
        owner: ConversationOwner,
        agent: HerdrAgentSnapshot,
        question: SeatQuestion,
        guard: () => Promise<void>,
      ) => Promise<void>)
    | undefined;
  private projectSeat: ProjectSeat | undefined;
  private watchingSummaries = false;
  private stateUnreadable = false;
  private closed = false;
  private readonly nativeLaunchPolicy: NativeLaunchPolicy | undefined;
  private readonly fleetResources: FleetResourceRuntime | undefined;
  private readonly requireWorkerAccess: ((fleet?: string) => Promise<void | MachineAccessFence>) | undefined;
  private readonly hireDefaults: (() => Promise<HireProfile>) | undefined;
  private readonly maximumTrustMode: (() => Promise<boolean>) | undefined;
  private readonly workerSandbox: (() => Promise<WorkerSandbox | undefined>) | undefined;
  private readonly resolveModel: ((harness: string, model: string) => Promise<string>) | undefined;
  private readonly claudeAccounts: (() => Promise<readonly CodexAccount[]>) | undefined;
  private readonly accounts: () => Promise<readonly CodexAccount[]>;
  private readonly workerAccounts:
    | ((fleet: string | undefined, harness: WorkerAccountHarness) => Promise<MachineWorkerAccounts>)
    | undefined;
  private readonly accountHolds: (() => Promise<readonly WorkerAccountHold[]>) | undefined;
  private readonly resumeInventory: ((fleet?: string) => Promise<readonly HerdrAgentSnapshot[]>) | undefined;
  private readonly onWorkerSettled: ((seatId: string, occupantId: string) => void) | undefined;
  private readonly resumeStarts = new Map<string, Promise<void>>();

  public constructor(
    path: string,
    options: {
      readonly validateOwner?: (owner: ConversationOwner) => Promise<boolean>;
      readonly remoteHireReceipts?: RemoteHireReceipts;
      readonly channelReceipt?: HerdrWatchStore["channelReceipt"];
      readonly messageReceiver?: (agent: HerdrAgentSnapshot) => FleetSeatMessageReceiver;
      readonly nativeLaunchPolicy?: NativeLaunchPolicy;
      readonly fleetResources?: FleetResourceRuntime;
      /** Its fence, when returned, lets a native write's final gate recheck it without I/O. */
      readonly requireWorkerAccess?: (fleet?: string) => Promise<void | MachineAccessFence>;
      readonly projectHirePolicy?: ProjectHirePolicy;
      readonly fleetHireTools?: () => Promise<readonly string[]>;
      readonly hireDefaults?: () => Promise<HireProfile>;
      readonly workerAccountsReport?: (fleet?: string) => Promise<MachineWorkerAccounts>;
      /** The owner's maximum trust mode (VUH-2048), read at each launch. Absent, it is off. */
      readonly maximumTrustMode?: () => Promise<boolean>;
      /** The OS profile local hires start under (VUH-2592), read at each launch. Absent, none. */
      readonly workerSandbox?: () => Promise<WorkerSandbox | undefined>;
      readonly resolveHireModel?: (harness: string, model: string) => Promise<string>;
      readonly claudeAccounts?: () => Promise<readonly CodexAccount[]>;
      readonly codexAccounts?: () => Promise<readonly CodexAccount[]>;
      /**
       * A linked machine's worker accounts, read there through the fleet link
       * (VUH-1527). Absent, remote hires keep that machine's default homes and
       * refuse an account override.
       */
      readonly workerAccounts?: (
        /** Omitted for this machine's registered profiles. */
        fleet: string | undefined,
        harness: WorkerAccountHarness,
      ) => Promise<MachineWorkerAccounts>;
      /** Owner holds that keep an account out of automatic choice. */
      readonly accountHolds?: () => Promise<readonly WorkerAccountHold[]>;
      readonly skillBundle?: {
        readonly repoRoot: string;
        readonly stateDir: string;
      };
      /** The state directory whose `claude-briefs` holds brief files; defaults to this store's. */
      readonly briefStateDir?: string;
      readonly runner?: HerdrWatchRunner;
      readonly available?: () => boolean;
      readonly summariesPath?: string;
      readonly summaryWatchIntervalMs?: number;
      readonly seatTranscriptTailMs?: number;
      /**
       * The settled agent's last message from its own transcript, for panes
       * Clankie did not hire (no seat event carries their final text).
       */
      readonly lastReply?: (agent: HerdrAgentSnapshot) => Promise<string | undefined>;
      /**
       * Wait for the leading conversation's next round before a routine
       * completion wakes it (VUH-2274). The watch stays durable meanwhile.
       */
      readonly awaitRound?: (conversationId: string, signal: AbortSignal) => Promise<void>;
      /**
       * How an open worker question keeps reaching its lead (ADR 0322): a
       * deferred wake is retried after `retryMs`, an accepted one is repeated
       * every `remindMs`, for `windowMs` after it was asked.
       */
      readonly questionReminders?: {
        readonly retryMs: number;
        readonly remindMs: number;
        readonly windowMs: number;
      };
      /** A hosted body's model for pi seats (VUH-1373); absent, pi uses its own configuration. */
      readonly piSeatModel?: () => Promise<PiSeatModel | undefined>;
      /** Host admission before account selection, reuse or native startup. */
      readonly hireRefusal?: (input: HireRequest) => Promise<string | undefined>;
      /**
       * How many hired agents run now and how many this body allows (VUH-1388).
       * Absent, or undefined when asked, there is no limit.
       */
      readonly hireCapacity?: () => Promise<{ readonly live: number; readonly limit: number } | undefined>;
      /**
       * Whether a remote fleet may start work in this directory (ADR 0184,
       * ADR 0193). This machine cannot stat that one, so the owner's workspace
       * grant for the fleet is the check. Absent, no remote hire is admitted.
       */
      readonly remoteWorkspace?: (fleet: string, directory: string) => Promise<boolean>;
      /**
       * Programmatic control by harness (ADR 0203, VUH-1458). A briefed local
       * hire of a listed harness is started, messaged and watched through its
       * adapter, with herdr as its view; unsupported briefs fail without terminal input.
       */
      readonly seatAdapters?: readonly HarnessSeatAdapter[];
      /** Off keeps unbriefed hosted Pi on its terminal path; native briefs still refuse. */
      readonly piNativeEnabled?: () => Promise<boolean>;
      /**
       * A remote fleet's own adapters (VUH-1527). A briefed hire on that fleet
       * of a listed harness gets the same native channel a local one does;
       * any other remote brief still fails without terminal input.
       */
      readonly remoteSeatAdapters?: (fleet: string) => readonly HarnessSeatAdapter[];
      readonly fleetAvailable?: (fleet: string) => boolean;
      readonly fleetRevision?: (fleet: string) => number;
      /** `codex queue` on a remote fleet's machine, for its Codex sessions he did not start. */
      readonly remoteCodexControl?: (fleet: string, paneId: string) => ExternalCodexControl | undefined;
      readonly remoteCodexQueue?: (
        fleet: string,
        sessionId: string,
        text: string,
        beforeDispatch?: () => Promise<boolean>,
        paneId?: string,
      ) => Promise<boolean | FleetSeatDelivery>;
      /** Include every configured Herdr server on the same exact SSH destination. */
      readonly resumeInventory?: (fleet?: string) => Promise<readonly HerdrAgentSnapshot[]>;
      /** Best-effort notification before a settled watch waits for its lead's report round. */
      readonly onWorkerSettled?: (seatId: string, occupantId: string) => void;
      /** A seat re-adopted by its hiring conversation, for its persona's name (VUH-2667). */
      readonly onReadopted?: (seat: {
        occupantId: string;
        title: string;
        harness: string;
        name?: string;
      }) => void;
    } = {},
  ) {
    this.onWorkerSettled = options.onWorkerSettled;
    this.path = path;
    this.briefStateDir = options.briefStateDir ?? dirname(path);
    this.remoteHireReceipts = options.remoteHireReceipts;
    this.channelReceipt = options.channelReceipt;
    this.validateOwner = options.validateOwner;
    this.onReadopted = options.onReadopted;
    this.hireOwners = new HireOwners(`${path}.owners.json`);
    this.nativeLaunchPolicy = options.nativeLaunchPolicy;
    this.fleetResources = options.fleetResources;
    this.requireWorkerAccess = options.requireWorkerAccess;
    this.projectHires = new ProjectHires(`${path}.project-hires.json`, (intent) => {
      const record = this.hireReceipts.all().find(([, receipt]) => receipt.freshHire?.id === intent)?.[1];
      return record
        ? `Native receipt ${record.messageId}: ${record.settlement ? `settled ${"disposition" in record.settlement ? record.settlement.disposition : "not-launched"}` : "unresolved"}.`
        : "Native receipt not observed; no replay is authorized.";
    });
    this.projectPolicy = options.projectHirePolicy;

    this.fleetHireTools = options.fleetHireTools;
    this.hireReceipts = new DeliveryFence(`${path}.hire-receipts.json`);
    this.skillBundle = options.skillBundle;
    this.hireDefaults = options.hireDefaults;
    if (options.workerAccountsReport) this.workerAccountsReport = options.workerAccountsReport;
    this.maximumTrustMode = options.maximumTrustMode;
    this.workerSandbox = options.workerSandbox;
    this.resolveModel = options.resolveHireModel;
    this.claudeAccounts = options.claudeAccounts;
    this.accounts = options.codexAccounts ?? (async () => codexAccounts());
    this.workerAccounts = options.workerAccounts;
    this.accountHolds = options.accountHolds;
    this.remoteWorkspace = options.remoteWorkspace;
    this.piSeatModel = options.piSeatModel;
    this.hireRefusal = options.hireRefusal;
    this.hireCapacity = options.hireCapacity;
    this.runner = options.runner ?? createHerdrWatchRunner(options.available);
    this.hiredRestarts = new HiredSeatRestarts(`${path}.hired-restarts.json`, this.runner, async (pane) => {
      const proof = await this.projectPolicy?.proof?.("default", pane);
      if (!proof || proof.nativeSessionPending) return undefined;
      const { nativeOccupantId, fleet, binding, processes, shell } = proof;
      return ProjectHireProcessProofSchema.parse({
        nativeOccupantId,
        fleet,
        pane: proof.pane,
        binding,
        processes,
        shell,
      }) as ProjectHireProcessProof;
    });
    this.resumeInventory = options.resumeInventory;
    this.piNativeEnabled = options.piNativeEnabled;
    this.seatAdapters = new Map((options.seatAdapters ?? []).map((adapter) => [adapter.harness, adapter]));
    const remoteSeatAdapters = options.remoteSeatAdapters;
    // One adapter set per fleet, made once: an adapter holds its seats' live control.
    const remote = new Map<string, { revision: number; adapters: ReadonlyMap<string, HarnessSeatAdapter> }>();
    this.remoteSeatAdapters = (fleet) => {
      // The desktop app's terminals are this machine's (ADR 0319): a hire there launched
      // through the local adapters, so its channel and mailbox answer through them too.
      if (fleet === HERDR_CORE_FLEET) return this.seatAdapters;
      return remoteFleetAdapters?.(fleet);
    };
    const remoteFleetAdapters =
      remoteSeatAdapters === undefined
        ? undefined
        : (fleet: string) => {
            if (options.fleetAvailable?.(fleet) === false) {
              remote.delete(fleet);
              return undefined;
            }
            const revision = options.fleetRevision?.(fleet) ?? 0;
            let cached = remote.get(fleet);
            if (cached === undefined || cached.revision !== revision) {
              cached = {
                revision,
                adapters: new Map(remoteSeatAdapters(fleet).map((adapter) => [adapter.harness, adapter])),
              };
              remote.set(fleet, cached);
            }
            return cached.adapters;
          };
    this.seatControl = createFleetSeatControl(
      this.runner,
      this.seatAdapters,
      this.remoteSeatAdapters,
      options.remoteCodexQueue,
      options.remoteCodexControl,
      `${this.path}.delivery-receipts.json`,
      options.channelReceipt,
      options.messageReceiver,
    );
    this.summariesPath = options.summariesPath ?? herdrSummariesPath();
    this.summaryWatchIntervalMs = options.summaryWatchIntervalMs ?? 1_000;
    this.seatTranscriptTailMs = options.seatTranscriptTailMs ?? SEAT_TRANSCRIPT_TAIL_MS;
    this.lastReply = options.lastReply;
    this.awaitRound = options.awaitRound;
    this.questionReminders = options.questionReminders ?? QUESTION_REMINDERS;
    this.state = this.read();

    const context = HerdrWatchStore.watchContext(this);
    this.delivery = createHerdrWatchDelivery(context);
    this.questions = createHerdrWatchQuestions(context);
    this.ownership = createHerdrWatchOwnership(context);
    this.hiring = createHerdrWatchHiring(context);
    this.recovery = createHerdrWatchRecovery(context);
    this.startup = createHerdrWatchLaunch(context);
    this.lifecycle = createHerdrWatchLifecycle(context);
    this.observation = createHerdrWatchObservation(context);
  }

  /** Only this service's original successful native launches carry restart authority. */
  public freshRestartCandidates(): Promise<readonly HiredRestartCandidate[]> {
    return this.observation.freshRestartCandidates();
  }

  public hiredRestartReceipts(): readonly HiredRestartReceipt[] {
    return this.observation.hiredRestartReceipts();
  }

  public start(wake: InternalWake, projectSeat?: ProjectSeat): void {
    return this.observation.start(wake, projectSeat);
  }

  /** Body-free native delivery observations, including persisted legacy fences. */
  public unresolvedSeatDeliveries() {
    return this.delivery.unresolvedSeatDeliveries();
  }

  private scopedDelivery(id: string, conversationId: string, ownerSettlement = false) {
    return this.delivery.scopedDelivery(id, conversationId, ownerSettlement);
  }

  public reconcileSeatDelivery(id: string, conversationId: string) {
    return this.delivery.reconcileSeatDelivery(id, conversationId);
  }

  /** The lead's explicit settle (VUH-2358), scoped like owner settlement. */
  public settleSeatDelivery(id: string, conversationId: string) {
    return this.delivery.settleSeatDelivery(id, conversationId);
  }

  public abandonSeatDelivery(id: string, conversationId: string, beforeSettlement?: () => Promise<void>) {
    return this.delivery.abandonSeatDelivery(id, conversationId, beforeSettlement);
  }

  /**
   * The seat id a `clankie mcp --seat` bridge should poll, given the pane it
   * sits in (`HERDR_PANE_ID`). Herdr accepts a moved pane's old id as an alias.
   * `undefined` until the pane holds a messageable agent.
   */
  public seatIdForPane(paneId: string): Promise<string | undefined> {
    return this.delivery.seatIdForPane(paneId);
  }

  /** Read only the answer to an explicitly sent room prompt, never prior pane activity. */
  public sendAndWatchReply(seatId: string, text: string, deliver: () => Promise<boolean>): Promise<boolean> {
    return this.delivery.sendAndWatchReply(seatId, text, deliver);
  }

  public readNativeChat(
    seatId: string,
    previous?: HerdrAgentSnapshot,
  ): Promise<
    | {
        agent: HerdrAgentSnapshot;
        transcript: HerdrSeatTranscript;
      }
    | undefined
  > {
    return this.delivery.readNativeChat(seatId, previous);
  }

  /** Only an explicit room prompt may use the transcriptless answer fallback. */
  private readRoomReply(seatId: string) {
    return this.delivery.readRoomReply(seatId);
  }

  /** Compact display snapshots share one bounded, oldest-write-first cache. */
  private cacheNativeChat(path: string, transcript: HerdrSeatTranscript): void {
    return this.delivery.cacheNativeChat(path, transcript);
  }

  /** Controller observations and actions retain the exact native occupant. */
  public inputCapabilities(agent: HerdrAgentSnapshot): Promise<FleetSeatInputCapabilities> {
    return this.delivery.inputCapabilities(agent);
  }

  /** Controller observations and actions retain the exact native occupant. */
  public nativeTaskObservation(
    seatId: string,
    holderId?: string,
  ): Promise<{ binding: string; status: string; queueSupported: boolean } | undefined> {
    return this.delivery.nativeTaskObservation(seatId, holderId);
  }

  public stopNativeTask(
    seatId: string,
    binding: string,
    authorize: () => Promise<void>,
  ): Promise<StopNativeTaskResult> {
    return this.delivery.stopNativeTask(seatId, binding, authorize);
  }

  public sendToSeat(seatId: string, text: string, uncontrolled?: () => Promise<boolean>): Promise<boolean> {
    return this.delivery.sendToSeat(seatId, text, uncontrolled);
  }

  public deliverToSeat(
    seatId: string,
    text: string,
    uncontrolled?: (attempt?: PeerDeliveryOptions) => Promise<FleetSeatDelivery>,
    options?: PeerDeliveryOptions,
  ): Promise<FleetSeatDelivery> {
    return this.delivery.deliverToSeat(seatId, text, uncontrolled, options);
  }

  /** Host-observed native question, bound to the original occupant; model text is never evidence. */
  public observedSeatQuestion(seatId: string, requestId: string | number) {
    return this.questions.observedSeatQuestion(seatId, requestId);
  }

  /** Only an online exact native control can prove an ask was answered elsewhere. */
  public workerQuestionStatus(
    seatId: string,
    requestId: string | number,
    sessionId: string,
  ): Promise<"pending" | "resolved" | "unknown"> {
    return this.questions.workerQuestionStatus(seatId, requestId, sessionId);
  }

  public answerSeatQuestion(
    seatId: string,
    answer: SeatQuestionAnswer,
    source: ConversationAuthority,
    expectedSessionId?: string,
    ownerPrincipal?: import("./conversation-questions.ts").QuestionAuthority["principal"],
  ): Promise<FleetSeatDelivery> {
    return this.questions.answerSeatQuestion(seatId, answer, source, expectedSessionId, ownerPrincipal);
  }

  public forwardNativeQuestion(ref: SeatRef, question: SeatQuestion): Promise<void> {
    return this.questions.forwardNativeQuestion(ref, question);
  }

  /** A question its lead may not answer goes to the owner's structured ask instead. */
  private ownerMustAnswer(
    owner: ConversationOwner,
    agent: HerdrAgentSnapshot,
    question: SeatQuestion,
  ): Promise<boolean> {
    return this.questions.ownerMustAnswer(owner, agent, question);
  }

  private escalateToOwner(
    owner: ConversationOwner,
    agent: HerdrAgentSnapshot,
    question: SeatQuestion,
    guard: () => Promise<void>,
    asked?: () => void,
  ): Promise<void> {
    return this.questions.escalateToOwner(owner, agent, question, guard, asked);
  }

  /**
   * An open question keeps reaching whoever leads the hire's conversation now
   * (ADR 0322). A wake no lead took is retried, and a taken one is repeated
   * while the question stays unanswered, so a lead that connected late, or
   * Clankie when the lead that was told has gone, still hears it. No lead
   * outranks another: the first answer wins and later ones are refused.
   */
  private remindOpenQuestion(
    asked: HerdrAgentSnapshot,
    requestId: string | number,
    text: string,
    deferred: boolean,
  ): void {
    return this.questions.remindOpenQuestion(asked, requestId, text, deferred);
  }

  /** Reuse native attachment/queue capability; bridge display cards grant nothing. */
  public nativeRouteAvailable(agent: HerdrAgentSnapshot): Promise<boolean> {
    return this.ownership.nativeRouteAvailable(agent);
  }

  /** Native waiting detail is display metadata; census identity and authority stay unchanged. */
  public refreshWorkerCatalog(
    paneId: string,
    input: { revision: string; beforeDispatch?: () => Promise<void> },
  ): Promise<{ outcome: "refreshed" | "skipped-busy" | "failed"; reason: string }> {
    return this.ownership.refreshWorkerCatalog(paneId, input);
  }

  public withNativeStatus(
    seats: readonly OperatorFleetSeat[],
    observed: readonly ObservedFleetSeat[],
  ): Promise<readonly OperatorFleetSeat[]> {
    return this.ownership.withNativeStatus(seats, observed);
  }

  /** Only fresh host-observed native proof selects a worker's leading conversation. */
  public nativeOwner(agent: HerdrAgentSnapshot): ConversationOwner | undefined {
    return this.ownership.nativeOwner(agent);
  }

  public reportLeads(agent: HerdrAgentSnapshot) {
    return this.ownership.reportLeads(agent);
  }
  public grantReportLead(agent: HerdrAgentSnapshot, lead: import("./hire-owners.ts").HireReportLead): void {
    return this.ownership.grantReportLead(agent, lead);
  }

  public revokeReportLead(agent: HerdrAgentSnapshot, id: string): void {
    return this.ownership.revokeReportLead(agent, id);
  }
  /** Who asked for this exact occupant's hire (ADR 0321); display only. */
  /** Whether Clankie recorded hiring this seat with this native session (#584). */
  public hiredSession(seatId: string, harness: string, sessionId: string): boolean {
    return this.ownership.hiredSession(seatId, harness, sessionId);
  }

  public seatStarter(seatId: string, occupantId: string): HireStarter | undefined {
    return this.ownership.seatStarter(seatId, occupantId);
  }

  /** The lead a hire on this seat or pane named for report wakes (#735). */
  public notifyLead(seatId: string | undefined, paneId: string): string | undefined {
    return this.ownership.notifyLead(seatId, paneId);
  }

  /** Whether a seat holds a finished hire, for a start receipt that outlived its service (#735). */
  public hiredSeat(seatId: string): boolean {
    return this.ownership.hiredSeat(seatId);
  }

  /** Whether this connector device hired this exact occupant and still leads it (#442). */
  public connectorLeads(seatId: string, occupantId: string, deviceId: string): boolean {
    return this.ownership.connectorLeads(seatId, occupantId, deviceId);
  }

  /** Whether a pane holds a Clankie hire, for fleet-health alert attribution only (#324). */
  public paneHire(paneId: string, requireProvenance = false): "starting" | "hired" | undefined {
    return this.ownership.paneHire(paneId, requireProvenance);
  }

  /**
   * A seat's live agent, read again briefly while Herdr names no native session for it: a
   * worker that can send reports can be messaged too, even when one snapshot misses its
   * session (#338). A seat with no agent, or no session after the retries, is returned as
   * read, for the caller's own refusal; nothing is inferred. The retries take up to a second
   * or so, so callers check again that the service is still open once it returns.
   */
  private async seatWithSession(
    read: () => Promise<HerdrAgentSnapshot | undefined>,
  ): Promise<HerdrAgentSnapshot | undefined> {
    let agent = await read();
    for (
      let attempt = 0;
      attempt < SEAT_SESSION_RETRIES &&
      !this.closed &&
      isMessageableSeat(agent) &&
      agent.session === undefined;
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, SEAT_SESSION_RETRY_MS));
      agent = await read();
    }
    return agent;
  }

  /** The persisted lead of this exact native occupant, for the census; grants nothing. */
  public seatClaim(agent: HerdrAgentSnapshot): { owner: ConversationOwner; hired: boolean } | undefined {
    return agent.session === undefined
      ? undefined
      : this.hireOwners.claim(agent.paneId, agent.terminalId, occupantIdForHerdrSession(agent.session));
  }

  /** Read-only provenance for holding a verified worker report while re-adoption is required. */
  public retainedReportOwner(agent: HerdrAgentSnapshot): ConversationOwner | undefined {
    return this.ownership.retainedReportOwner(agent);
  }

  /** Persist adoption before native delivery so an immediate report sees its new lead. */
  /**
   * Make this conversation the seat's lead before it messages the seat. A live
   * hire another conversation leads keeps that lead (VUH-1763): the message
   * still goes, and the result names the lead so reports keep returning there.
   */
  public adoptSeat(
    seatId: string,
    source: ConversationAuthority,
  ): Promise<{ adopted: true } | { adopted: false; ownerConversationId: string }> {
    return this.ownership.adoptSeat(seatId, source);
  }

  /** Repair a legitimate reattachment only under the thread's existing owning conversation. */
  public readoptSeat(seatId: string, source: ConversationAuthority): Promise<void> {
    return this.ownership.readoptSeat(seatId, source);
  }

  private nativeSessionKey(agent: HerdrAgentSnapshot): string | undefined {
    return this.ownership.nativeSessionKey(agent);
  }

  private retireReboundWatches(
    replaced: readonly { seatId?: string | undefined; occupantId?: string | undefined }[],
    current: HerdrAgentSnapshot,
  ): void {
    return this.ownership.retireReboundWatches(replaced, current);
  }

  private bindHireOwner(
    agent: HerdrAgentSnapshot,
    input: SpawnOperatorSeat,
    authority: HireAuthority,
  ): Promise<void> {
    return this.ownership.bindHireOwner(agent, input, authority);
  }

  /** Why a hire's own runtime ended under its still-open pane; undefined while it runs. */
  public stoppedReason(agent: HerdrAgentSnapshot): Promise<string | undefined> {
    return this.ownership.stoppedReason(agent);
  }

  /** The herdr status an adapter-held seat's own status reads as; undefined when no adapter holds it. */
  private adapterStatus(agent: HerdrAgentSnapshot): Promise<string | undefined> {
    return this.ownership.adapterStatus(agent);
  }

  /**
   * The seat's status once a message has had a moment to start a turn: an idle
   * seat right after delivery would read as already settled to `herdr_watch`.
   * Returns the last status seen when the wait runs out.
   */
  public awaitPickup(seatId: string, timeoutMs = SEAT_PICKUP_WAIT_MS): Promise<string> {
    return this.ownership.awaitPickup(seatId, timeoutMs);
  }

  /**
   * Hire an agent (ADR 0013): a tab in the chosen directory, a harness started
   * in it, and the seat it became. Every failure is an outcome rather than a
   * throw — the surface renders "couldn't hire" and keeps the operator's draft.
   *
   * A start that fails leaves no stray tab behind: the pane opened for it is
   * closed on the way out, so a retry does not accumulate empty shells.
   */
  /**
   * Hire a seat. `subject` is the herdr agent name, which is also the key the
   * persona binding hangs on — a move passes the old one so the character
   * comes with it instead of a stranger arriving in the new district.
   */
  /**
   * The model a pi seat starts on. A hosted body on included usage runs every
   * pi worker on its own included model, whatever was asked, since no other
   * provider has a key there; a `clankie/…` alias that was asked for stays. On
   * the customer's own credential the worker defaults to their model.
   * Elsewhere pi keeps its own configuration.
   */
  private hostedPiModel(requested: string | undefined): Promise<string | undefined> {
    return this.ownership.hostedPiModel(requested);
  }

  public leadHireMembershipOwner(pane: string, seat: string, occupant: string) {
    return this.ownership.leadHireMembershipOwner(pane, seat, occupant);
  }
  /**
   * Like `hireRetained`, but a settled original no longer counts: only a launch that may still
   * be running unconfirmed (#614). A folder whose hire settled takes new work elsewhere; its
   * original key stays fenced against replay. With a harness, only that harness's launches count.
   */
  public hireUnresolved(input: {
    readonly fleet?: string | undefined;
    readonly workingDirectory: string;
    readonly harness?: string | undefined;
  }): boolean {
    return this.ownership.hireUnresolved(input);
  }

  /**
   * Whether a new launch into this folder is still unresolved or was settled by recovery. A retry
   * of that launch must arrive at the same folder (ADR 0207, ADR 0306). With a harness, only that
   * harness's launches count: a launch under another harness is never this one's retry, so it
   * doesn't pin a new start to the folder.
   */
  public hireRetained(input: {
    readonly fleet?: string | undefined;
    readonly workingDirectory: string;
    readonly harness?: string | undefined;
  }): boolean {
    return this.ownership.hireRetained(input);
  }

  /**
   * Whether this exact lead brief already started a hire in this folder that recovery then
   * settled (#730). Resending it is a possible duplicate, so it is refused rather than moved
   * to a fresh worktree. Receipts from before the lead fingerprint was kept never match.
   */
  public hireResent(input: {
    readonly fleet?: string | undefined;
    readonly workingDirectory: string;
    readonly harness?: string | undefined;
    readonly leadFingerprint: string;
  }): boolean {
    return this.ownership.hireResent(input);
  }

  private launchHeld(
    input: {
      readonly fleet?: string | undefined;
      readonly workingDirectory: string;
      readonly harness?: string | undefined;
    },
    held: (key: string) => boolean,
    /** Whether an unresolved project hire or an unreadable journal holds the folder too. */
    conservative = true,
  ): boolean {
    return this.ownership.launchHeld(input, held, conservative);
  }
  /** The title this seat was hired under, from Clankie's own hire ledger (LOCAL-VUH-59). */
  public hireTitle(seat: { readonly paneId: string; readonly occupantId: string }): string | undefined {
    return this.ownership.hireTitle(seat);
  }
  /** Whether this seat is a deliberate attempt at its deliverable, and whether it was superseded (#602). */
  public hireAttempt(seat: { readonly paneId: string }) {
    return this.ownership.hireAttempt(seat);
  }
  /** Original allocation evidence for the exact currently observed native occupant. */
  public missingWorktreeClaim(agent: HerdrAgentSnapshot) {
    return this.ownership.missingWorktreeClaim(agent);
  }

  /**
   * The exact attempt allocation this pane's current occupant holds, captured before a
   * close releases it (#602). Undefined unless the ledger's occupant is this session.
   */
  public hireAttemptRecord(
    agent: HerdrAgentSnapshot,
  ): { readonly allocation: string; readonly occupantId: string } | undefined {
    return this.ownership.hireAttemptRecord(agent);
  }
  /**
   * Settle the captured attempt's deliverable from each attempt's launch record and the
   * pull request GitHub merged from its hire branch (#602); see settleAttemptByMerge.
   */
  public settleHireAttempt(
    record: { readonly allocation: string; readonly occupantId: string },
    launchOf: (candidate: AttemptCandidate) => AttemptLaunch | undefined,
    mergedPull: (repository: string, launch: AttemptLaunch) => Promise<AttemptMerge | undefined>,
  ): Promise<AttemptSettlement | undefined> {
    return this.ownership.settleHireAttempt(record, launchOf, mergedPull);
  }
  /**
   * The project a seat's current occupant was hired into, and the GitHub repository of the
   * checkout it was hired in, from the hire ledger; display only.
   */
  public hiredProject(
    seatId: string,
    occupantId: string,
  ): { readonly projectId: string; readonly repository?: string } | undefined {
    return this.ownership.hiredProject(seatId, occupantId);
  }
  private readonly githubOrigin = createGithubOriginReader();
  public projectHireMembershipCandidate(fleet: string, pane: string) {
    return this.ownership.projectHireMembershipCandidate(fleet, pane);
  }
  /** Retained exit bookkeeping only; the caller first proves the original native assignment. */
  public projectHireBookkeepingAttribution(fleet: string, pane: string, occupantId: string) {
    return this.ownership.projectHireBookkeepingAttribution(fleet, pane, occupantId);
  }
  public confirmedProjectHireAssignment(
    fleet: string,
    pane: string,
    revision: string,
    proof: ProjectHireProcessProof,
  ) {
    return this.ownership.confirmedProjectHireAssignment(fleet, pane, revision, proof);
  }

  public projectHireAssignment(fleet: string, pane: string, proof?: ProjectHireProcessProof) {
    return this.ownership.projectHireAssignment(fleet, pane, proof);
  }

  /** A legacy bare allocation is still a hire, never an owner-started workspace fallback. */
  private legacyProjectHire(fleet: string, pane: string) {
    return this.ownership.legacyProjectHire(fleet, pane);
  }

  private projectHireProof(fleet: string, pane: string, proof?: ProjectHireProcessProof) {
    return this.ownership.projectHireProof(fleet, pane, proof);
  }

  /** Describe the original blocker and existing operator recovery commands; never changes it. */
  private projectHireBlocker(id: string): string {
    return this.ownership.projectHireBlocker(id);
  }

  public spawnSeat(
    inputRequest: HireRequest,
    subjectOverride?: string,
    brief?: string,
    resume?: SavedAgentSession,
    authority?: HireAuthority,
    adopt?: AdoptHire,
    flushAdoption?: () => Promise<void>,
    /** The caller captures task intent before adding service-owned standing context. */
    taskBrief = brief !== undefined,
    /** The lead brief's fingerprint before that context, kept on the hire receipt (#730). */
    leadFingerprint?: string,
  ): Promise<HerdrSeatSpawnResult> {
    return this.hiring.spawnSeat(
      inputRequest,
      subjectOverride,
      brief,
      resume,
      authority,
      adopt,
      flushAdoption,
      taskBrief,
      leadFingerprint,
    );
  }

  /**
   * The harness for a hire that names none at any layer. A resumed session
   * keeps its own. Otherwise the hire's machine decides from its usable
   * accounts the owner has not held, within the family of any requested model
   * (`chooseWorkerHarness`); nothing is assumed when they cannot be read.
   */
  private chooseHireHarness(
    input: HireRequest,
    resume?: SavedAgentSession,
    policy?: import("@clankie/protocol/projects").ProjectHiringPolicy,
    work = false,
    ownerHire?: ConversationAuthority["ownerHire"],
  ): Promise<
    { readonly harness: SpawnOperatorSeat["harness"]; readonly why?: string } | HerdrSeatSpawnResult
  > {
    return this.hiring.chooseHireHarness(input, resume, policy, work, ownerHire);
  }

  private admitProjectLaunch(
    input: SpawnOperatorSeat,
    dispatched = false,
    authorityOverride?: ConversationAuthority,
  ): Promise<void> {
    return this.hiring.admitProjectLaunch(input, dispatched, authorityOverride);
  }

  private runProjectPolicy(action: () => Promise<void>): Promise<void> {
    return this.hiring.runProjectPolicy(action);
  }

  private admitResourceMutation(input: SpawnOperatorSeat, authority?: HireAuthority): Promise<void> {
    return this.hiring.admitResourceMutation(input, authority);
  }

  private expectedHireTools(input: SpawnOperatorSeat): Promise<readonly string[]> {
    return this.hiring.expectedHireTools(input);
  }

  private resolveHireModels(input: SpawnOperatorSeat): Promise<SpawnOperatorSeat> {
    return this.hiring.resolveHireModels(input);
  }
  private spawnAdmittedSeat(
    input: SpawnOperatorSeat,
    subjectOverride?: string,
    brief?: string,
    resume?: SavedAgentSession,
    authority?: HireAuthority,
    adopt?: AdoptHire,
    flushAdoption?: () => Promise<void>,
    work = false,
    leadFingerprint?: string,
  ): Promise<HerdrSeatSpawnResult> {
    return this.hiring.spawnAdmittedSeat(
      input,
      subjectOverride,
      brief,
      resume,
      authority,
      adopt,
      flushAdoption,
      work,
      leadFingerprint,
    );
  }

  private performSpawnSeat(
    input: SpawnOperatorSeat,
    subjectOverride?: string,
    brief?: string,
    resume?: SavedAgentSession,
    authority?: HireAuthority,
    adopt?: AdoptHire,
    flushAdoption?: () => Promise<void>,
    leadFingerprint?: string,
  ): Promise<HerdrSeatSpawnResult> {
    return this.hiring.performSpawnSeat(
      input,
      subjectOverride,
      brief,
      resume,
      authority,
      adopt,
      flushAdoption,
      leadFingerprint,
    );
  }

  private remoteClaim(
    key: string,
    receipt: import("./delivery-fence.ts").UncertainReceipt,
  ): RemoteHireClaim | undefined {
    return this.hiring.remoteClaim(key, receipt);
  }

  /** Irreversible local guard plus the remote host's exclusive launch CAS, before every effect. */
  private commitRemoteLaunch(key?: string, input?: SpawnOperatorSeat): Promise<void> {
    return this.hiring.commitRemoteLaunch(key, input);
  }

  /** SSH receipt operations do not retain the turn's authority or project/target grant. */
  private assertRemoteHireAuthority(
    input: SpawnOperatorSeat,
    key: string | undefined,
    authority: HireAuthority | undefined,
  ): Promise<void> {
    return this.hiring.assertRemoteHireAuthority(input, key, authority);
  }

  /** Retire completed receipts only against a complete census on their unchanged configured host. */
  /**
   * A new remote hire at a place whose last hire was settled, or that already
   * holds fresh-intent history, can start only as a fresh intent after that
   * last receipt (#100). Returns one for a caller that asks for new work on every
   * call, such as a connected app's start_agent; undefined when an ordinary
   * hire still fits. The fence still refuses while any hire there is unresolved.
   */
  public nextFreshIntent(
    fleet: string,
    harness: string,
    workingDirectory: string,
  ): { id: string; afterReceiptId: string } | undefined {
    return this.hiring.nextFreshIntent(fleet, harness, workingDirectory);
  }

  private retireCompletedHires(
    fleet: string,
    scope: { baseKey?: string; paneId?: string },
    guard?: () => Promise<void>,
  ): Promise<void> {
    return this.recovery.retireCompletedHires(fleet, scope, guard);
  }

  /** Resolve a fresh intent to its native fence; only its live owner or the operator may settle. */
  public settleHireReceipt(
    receiptId: string,
    guard?: () => Promise<void>,
    disposition:
      | "not-launched"
      | "delivered"
      | "abandoned"
      | "abandoned-unknown"
      | "release-allocation"
      | "adopt" = "not-launched",
    owner?: ConversationOwner,
  ): Promise<HireReceiptSettlement> {
    return this.recovery.settleHireReceipt(receiptId, guard, disposition, owner);
  }

  /** Operator recovery only. Takes identity, never caller-supplied evidence or a launch request. */
  private settleNativeHireReceipt(
    receiptId: string,
    guard?: () => Promise<void>,
    disposition:
      | "not-launched"
      | "delivered"
      | "abandoned"
      | "abandoned-unknown"
      | "release-allocation" = "not-launched",
    expectedAllocation?: NonNullable<ReturnType<ProjectHires["recoveryCandidate"]>>,
  ): Promise<HireReceiptSettlement> {
    return this.recovery.settleNativeHireReceipt(receiptId, guard, disposition, expectedAllocation);
  }

  /** An unresolved or locally settled original with no remote host admission. */
  private localHireReceipt(receiptId: string): boolean {
    return this.recovery.localHireReceipt(receiptId);
  }

  /**
   * Whether a present pane holds only its own shell: no harness or session
   * reported, and its shell is the only foreground process (VUH-2243).
   */
  private shellOnlyPane(pane: HerdrAgentSnapshot): Promise<number | string> {
    return this.recovery.shellOnlyPane(pane);
  }

  private unrecordedHireStale(beganAt: number | undefined): boolean {
    return this.recovery.unrecordedHireStale(beganAt);
  }

  /**
   * Frees a project place in this directory whose earlier hire's agent is gone (#251):
   * settles its native receipts as {@link retireGoneLocalHires} does, then releases a
   * stale allocation whose pane never appeared through the operator's own census.
   */
  private retireGoneProjectHires(workingDirectory: string, guard: () => Promise<void>): Promise<void> {
    return this.recovery.retireGoneProjectHires(workingDirectory, guard);
  }

  /**
   * Settles each unresolved hire at this place whose agent is gone (ADR 0331): its
   * recorded pane is absent from this machine's complete inventory or holds no harness,
   * or it never recorded a pane, is a few minutes old, and no such harness runs there.
   * The same proof the operator's settlement takes; a hire still running is left as is,
   * and a refusal changes nothing. Never closes, sends or relaunches anything.
   */
  private retireGoneLocalHires(baseKey: string, guard: () => Promise<void>): Promise<void> {
    return this.recovery.retireGoneLocalHires(baseKey, guard);
  }

  /**
   * Retire only a remote attempt sealed as never launched. Run before checkout or
   * project-allocation fences, since those can otherwise hide the existing seal.
   * A causal receipt link and the operator's double census protect the allocation.
   */
  public retireUnsentRemoteAt(
    input: {
      fleet?: string | undefined;
      workingDirectory: string;
      harness?: string | undefined;
      freshIntent?: { readonly id: string; readonly afterReceiptId: string } | undefined;
    },
    guard: () => Promise<void>,
    projectId?: string,
  ): Promise<void> {
    return this.recovery.retireUnsentRemoteAt(input, guard, projectId);
  }

  /**
   * Settles each earlier hire at this place on another machine whose launch was committed
   * but whose only effect was an unanswered workspace create (#326, amending ADR 0331).
   * No harness command left this service, so the host's authenticated census decides,
   * exactly as the operator's `not-launched` does: a pane in the hire's directory (a
   * create that landed late) keeps it fenced. Never closes, sends or relaunches anything.
   */
  private retireUnsentRemoteHires(baseKey: string, guard: () => Promise<void>): Promise<void> {
    return this.recovery.retireUnsentRemoteHires(baseKey, guard);
  }

  /**
   * Operator settlement of a local hire from this machine's complete Herdr
   * inventory (VUH-2243). Settles only while no harness occupies the original
   * pane (absent, or holding nothing but its shell), then frees the location for
   * a new hire. Never closes a pane, claims launch or delivery, or replays the brief.
   */
  private abandonLocalHireReceipt(
    receiptId: string,
    guard: () => Promise<void>,
  ): Promise<HireReceiptSettlement> {
    return this.recovery.abandonLocalHireReceipt(receiptId, guard);
  }

  /**
   * A settled local hire's own project allocation would otherwise keep refusing
   * every new hire in its place ("The earlier hire still needs checking"). Free it
   * through the operator release-allocation path, with that path's own complete
   * inventory checks: nothing in the original pane but its shell, and no worker in
   * its directory. The settlement stands whether or not the release passes.
   */
  private releaseSettledHireAllocation(
    receiptKey: string,
    paneId: string | undefined,
    guard: () => Promise<void>,
    abandoned: HireReceiptSettlement & { state: "abandoned" },
  ): Promise<HireReceiptSettlement> {
    return this.recovery.releaseSettledHireAllocation(receiptKey, paneId, guard, abandoned);
  }

  /**
   * Operator adoption of a launched local hire that never confirmed (VUH-2243).
   * Its harness runs in the pane this hire allocated, but its occupant was never
   * bound, so its lead cannot reach it. Binds that exact host-observed occupant
   * to the conversation that hired the pane, confirms its project allocation
   * from matching process proof, and settles the original receipt. It never
   * claims the brief arrived, and never sends, replays or closes anything.
   */
  private adoptLocalHire(id: string, guard: () => Promise<void>): Promise<HireReceiptSettlement> {
    return this.recovery.adoptLocalHire(id, guard);
  }

  /** Whether an adoption names a hire on another fleet machine: its receipt or its allocation. */
  private remoteAdoption(id: string): boolean {
    return this.recovery.remoteAdoption(id);
  }

  /**
   * Operator adoption of a hire on another fleet machine (#326): a hire that never
   * confirmed, such as one that waited on its harness's folder-trust prompt, runs idle
   * in its own pane with no session on its receipt. The fleet's census must show that
   * pane holding the hire's harness in its directory, twice and unchanged, and the
   * host's receipt program attests the same session before the receipt settles. An
   * older allocation whose original receipt can't be matched is adopted from the
   * census alone. Binds that exact occupant to the conversation that hired the pane
   * and confirms its allocation from matching process proof. Never sends, replays or
   * closes anything, and never claims the brief arrived.
   */
  private adoptRemoteHire(id: string, guard: () => Promise<void>): Promise<HireReceiptSettlement> {
    return this.recovery.adoptRemoteHire(id, guard);
  }

  /**
   * Auto-tidy's operator adoption (VUH-2802): a local project hire that never confirmed is
   * adopted only when its original receipt observed this exact native session and occupant,
   * and its hiring conversation is the one tidy would close it for. Everything else stays
   * for the lead, and the close keeps every other refusal.
   */
  public adoptUnconfirmedForTidy(
    agent: HerdrAgentSnapshot,
    owner: ConversationOwner,
    guard: () => Promise<void>,
  ): Promise<HireReceiptSettlement | undefined> {
    return this.recovery.adoptUnconfirmedForTidy(agent, owner, guard);
  }

  private recoverHireReceipt(
    receiptId: string,
    guard: () => Promise<void>,
    disposition: "delivered" | "abandoned" | "abandoned-unknown",
  ): Promise<HireReceiptSettlement> {
    return this.recovery.recoverHireReceipt(receiptId, guard, disposition);
  }

  private resumeSeat(
    input: SpawnOperatorSeat,
    session: SavedAgentSession,
    brief?: string,
    receiptKey?: string,
    authority?: HireAuthority,
  ): Promise<HerdrSeatSpawnResult> {
    return this.startup.resumeSeat(input, session, brief, receiptKey, authority);
  }

  private observeHireIdentity(
    receiptKey: string | undefined,
    agent: HerdrAgentSnapshot,
    input: SpawnOperatorSeat,
    authority?: HireAuthority,
    requireProof = false,
    preparedProof?: ProjectHireProcessProof,
  ): Promise<void> {
    return this.startup.observeHireIdentity(receiptKey, agent, input, authority, requireProof, preparedProof);
  }

  /**
   * Starts the seat, and states on its receipt which harness and account
   * Clankie chose for it and why, when the request left either open.
   */
  private startSeat(
    input: SpawnOperatorSeat,
    subjectOverride?: string,
    brief?: string,
    resume?: SavedAgentSession,
    receiptKey?: string,
    authority?: HireAuthority,
  ): Promise<HerdrSeatSpawnResult> {
    return this.startup.startSeat(input, subjectOverride, brief, resume, receiptKey, authority);
  }

  private launchSeat(
    input: SpawnOperatorSeat,
    chosen: { account?: string; reason?: string },
    subjectOverride?: string,
    brief?: string,
    resume?: SavedAgentSession,
    receiptKey?: string,
    authority?: HireAuthority,
  ): Promise<HerdrSeatSpawnResult> {
    return this.startup.launchSeat(input, chosen, subjectOverride, brief, resume, receiptKey, authority);
  }

  /** Inspect before closing the failed pane; trust and channel consent belong to the owner. */
  private startupFailure(
    paneId: string,
    harness: string,
    detail: string,
    reason: HerdrSeatSpawnFailure["reason"] = spawnFailureReason(detail),
  ): Promise<HerdrSeatSpawnFailure> {
    return this.startup.startupFailure(paneId, harness, detail, reason);
  }

  /**
   * Herdr calls a harness started once it takes input, which can be before the
   * harness has written the session file Herdr reports as its identity — pi
   * writes one on launch, so the gap is a race, not an absence. Waiting through
   * it is what keeps a good hire from being torn down as a failure.
   */
  /** A host checkout's path as this runner's panes and native threads see it (#402). */
  private nativeCheckout(workingDirectory: string): string {
    return this.startup.nativeCheckout(workingDirectory);
  }

  private agentWithSession(paneId: string, waitMs: number): Promise<HerdrAgentSnapshot> {
    return this.startup.agentWithSession(paneId, waitMs);
  }

  public tidy?: import("./pane-tidy.ts").PaneTidy;
  public issueStatus?: import("./seat-issue-status.ts").SeatIssueKeeper;

  /** Pane names and adopted ownership alone cannot authorize tidy. */
  public tidyProvenance(agent: HerdrAgentSnapshot) {
    return this.lifecycle.tidyProvenance(agent);
  }

  /**
   * Herdr restore preserves a native session but creates a new terminal and process.
   * Recover retirement authority from the exact completed hire, or the exact occupant an
   * operator adopted by its receipt (#578), never from a title, directory, ownership
   * adoption or today's project assignment. Original journals stay intact.
   */
  private restoredRetirementGuard(agent: HerdrAgentSnapshot): Promise<RetirementGuard> {
    return this.lifecycle.restoredRetirementGuard(agent);
  }

  /** Captured once before retirement. Unconfirmed launches retain their original process proof. */
  public retirementGuard(agent: HerdrAgentSnapshot): Promise<RetirementGuard> {
    return this.lifecycle.retirementGuard(agent);
  }

  /** Read-only capability preflight. Missing native exit cannot create a
   * close_unconfirmed journal when no exit could ever have been attempted. */
  public nativeExitAvailable(agent: HerdrAgentSnapshot): Promise<boolean> {
    return this.lifecycle.nativeExitAvailable(agent);
  }

  public closeSeat(seatId: string, guard?: SeatExitGuard, nativeOnly = false): Promise<boolean> {
    return this.lifecycle.closeSeat(seatId, guard, nativeOnly);
  }

  /**
   * Send a seat to another working directory (ADR 0166).
   *
   * A process cannot be moved: its directory is fixed when it is executed. So
   * the seat is closed and hired again where it is going, under the same agent
   * name — which is the persona's binding key, so the character, its thread,
   * and everything hanging off them come with it. The chair is new; the worker
   * in it is not.
   *
   * The old pane closes first. A hire that then fails leaves the seat gone
   * rather than duplicated, which is the failure the operator can see and act
   * on; a second live pane wearing the same name is one they cannot.
   */
  public moveSeat(input: {
    readonly seatId: string;
    readonly subject: string;
    readonly harness: SpawnOperatorSeat["harness"];
    readonly title: SpawnOperatorSeat["title"];
    readonly role?: SpawnOperatorSeat["role"];
    readonly workingDirectory: string;
  }): Promise<HerdrSeatMoveResult> {
    return this.lifecycle.moveSeat(input);
  }

  public trackSeat(seatId: string, mode: "status" | "head" = "status"): void {
    return this.observation.trackSeat(seatId, mode);
  }

  public untrackSeat(seatId: string): void {
    return this.observation.untrackSeat(seatId);
  }

  private watchHiredSeat(
    seatId: string,
    occupantId: string,
    owner: ConversationOwner,
    start = true,
    messageId?: string,
  ): HerdrWatchRecord | undefined {
    return this.observation.watchHiredSeat(seatId, occupantId, owner, start, messageId);
  }

  public watch(
    conversationId: string,
    target: string,
    reason: string,
    discord?: DiscordWatchOrigin,
    guard?: () => Promise<void>,
    messageId?: string,
  ): Promise<HerdrWatchArmResult> {
    return this.observation.watch(conversationId, target, reason, discord, guard, messageId);
  }

  public cancelConversation(conversationId: string): void {
    return this.observation.cancelConversation(conversationId);
  }

  public close(): void {
    return this.observation.close();
  }

  private runSeat(seatId: string, signal: AbortSignal, mode: "status" | "head"): Promise<void> {
    return this.observation.runSeat(seatId, signal, mode);
  }

  /**
   * Re-read the harness transcript while the pane works, so every message and
   * tool call reaches the app as it lands instead of only when the pane
   * settles. The registry drops entries it already holds, so a re-publish that
   * saw no new output costs nothing downstream.
   */
  // ponytail: the reader tails Codex, Grok and Claude by byte offset (Claude
  // replays from its last safe point when parallel results branch its chain),
  // so a poll costs the append rather than the session. Pi still re-parses on
  // change; give it Claude's checkpointed fold if a long Pi seat shows up in a profile.
  private followTranscript(
    seatId: string,
    current: HerdrAgentSnapshot,
    changed: Promise<HerdrAgentSnapshot>,
    signal: AbortSignal,
  ): Promise<HerdrAgentSnapshot> {
    return this.observation.followTranscript(seatId, current, changed, signal);
  }

  private publishSeatTranscript(seatId: string, agent: HerdrAgentSnapshot): Promise<boolean> {
    return this.observation.publishSeatTranscript(seatId, agent);
  }

  private readSeatReply(
    agent: HerdrAgentSnapshot,
    source: "visible" | "recent-unwrapped",
  ): Promise<string | undefined> {
    return this.observation.readSeatReply(agent, source);
  }

  private publishSeatStatus(seatId: string, status: string): void {
    return this.observation.publishSeatStatus(seatId, status);
  }

  private publishSeatSummary(
    seatId: string,
    paneId: string,
    summaries: Readonly<Record<string, HerdrAgentSummary>>,
  ): void {
    return this.observation.publishSeatSummary(seatId, paneId, summaries);
  }

  private ensureSummaryWatch(): void {
    return this.observation.ensureSummaryWatch();
  }

  private stopSummaryWatch(): void {
    return this.observation.stopSummaryWatch();
  }

  private readonly onSummariesChanged = (): void => {
    const summaries = readHerdrSummariesFile(this.summariesPath).agents;
    for (const seatId of this.headSeats) {
      if (this.transcriptSeats.has(seatId)) continue;
      void this.runner
        .resolveTerminal(seatId)
        .then((current) => {
          if (this.seatControllers.has(seatId) && isMessageableSeat(current)) {
            this.publishSeatSummary(seatId, current.paneId, summaries);
          }
        })
        .catch(() => undefined);
    }
  };

  private launch(record: HerdrWatchRecord): void {
    return this.observation.launch(record);
  }

  private watchOwner(record: HerdrWatchRecord): ConversationOwner | undefined {
    return this.observation.watchOwner(record);
  }

  private run(record: HerdrWatchRecord, signal: AbortSignal): Promise<void> {
    return this.observation.run(record, signal);
  }

  /**
   * A different native session, or the harness gone from the pane, ends the
   * watch. A harness whose session is not readable right now is retried.
   */
  private nativeEnd(
    record: HerdrWatchRecord,
    live: HerdrAgentSnapshot | undefined,
  ): HerdrWatchEnd | "unread" | undefined {
    return this.observation.nativeEnd(record, live);
  }

  /**
   * Another occupant's output never reaches the arming lead or a harvest, so a
   * native change produces no wake. It is settled in the ledger and the log
   * instead of vanishing (VUH-2208).
   */
  private endsOnNativeChange(record: HerdrWatchRecord, live: HerdrAgentSnapshot | undefined): boolean {
    return this.observation.endsOnNativeChange(record, live);
  }

  private get settlementsPath(): string {
    return `${this.path}.settled.json`;
  }

  private writeSidecar(path: string, value: unknown): void {
    return this.observation.writeSidecar(path, value);
  }

  /** Terminal settlements, newest last; never a delivery claim. */
  public settlements(): readonly HerdrWatchSettlement[] {
    return this.observation.settlements();
  }

  private recordSettlement(
    record: HerdrWatchRecord,
    outcome: HerdrWatchSettlement["outcome"],
    receiptId?: string,
  ): void {
    return this.observation.recordSettlement(record, outcome, receiptId);
  }

  private settle(
    record: HerdrWatchRecord,
    outcome: HerdrWatchSettlement["outcome"],
    receiptId?: string,
  ): void {
    return this.observation.settle(record, outcome, receiptId);
  }

  /** Observe state changes promptly, but still check native completion if status stays working. */
  private retryWorking(
    record: HerdrWatchRecord,
    pane: HerdrAgentSnapshot | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    return this.observation.retryWorking(record, pane, signal);
  }

  private retry(record: HerdrWatchRecord, delayMs = RETRY_ADMISSION_MS): void {
    return this.observation.retry(record, delayMs);
  }

  private harvestClaim(terminalId: string, occupantId: string, messageId: string) {
    return this.observation.harvestClaim(terminalId, occupantId, messageId);
  }

  private remove(id: string): void {
    return this.observation.remove(id);
  }

  private read(): PersistedHerdrWatches {
    if (!existsSync(this.path)) return { schemaVersion: 1, watches: [] };
    try {
      return PersistedHerdrWatchesSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      this.stateUnreadable = true;
      return { schemaVersion: 1, watches: [] };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    this.stateUnreadable = false;
  }

  private static watchContext(store: HerdrWatchStore): HerdrWatchContext {
    return {
      get seatControl() {
        return store.seatControl;
      },
      get runner() {
        return store.runner;
      },
      nativeOwner: (...args) => store.nativeOwner(...args),
      seatClaim: (...args) => store.seatClaim(...args),
      scopedDelivery: (...args) => store.scopedDelivery(...args),
      get closed() {
        return store.closed;
      },
      set closed(value) {
        store.closed = value;
      },
      readRoomReply: (...args) => store.readRoomReply(...args),
      get seatTranscriptTailMs() {
        return store.seatTranscriptTailMs;
      },
      get projectSeat() {
        return store.projectSeat;
      },
      set projectSeat(value) {
        store.projectSeat = value;
      },
      get path() {
        return store.path;
      },
      cacheNativeChat: (...args) => store.cacheNativeChat(...args),
      readNativeChat: (...args) => store.readNativeChat(...args),
      readSeatReply: (...args) => store.readSeatReply(...args),
      nativeTaskObservation: (...args) => store.nativeTaskObservation(...args),
      deliverToSeat: (...args) => store.deliverToSeat(...args),
      get requireWorkerAccess() {
        return store.requireWorkerAccess;
      },
      watchHiredSeat: (...args) => store.watchHiredSeat(...args),
      get watching() {
        return store.watching;
      },
      get permissionLeadAllowed() {
        return store.permissionLeadAllowed;
      },
      set permissionLeadAllowed(value) {
        store.permissionLeadAllowed = value;
      },
      get questionGate() {
        return store.questionGate;
      },
      set questionGate(value) {
        store.questionGate = value;
      },
      get hireOwners() {
        return store.hireOwners;
      },
      get wake() {
        return store.wake;
      },
      set wake(value) {
        store.wake = value;
      },
      ownerMustAnswer: (...args) => store.ownerMustAnswer(...args),
      escalateToOwner: (...args) => store.escalateToOwner(...args),
      remindOpenQuestion: (...args) => store.remindOpenQuestion(...args),
      get escalateQuestion() {
        return store.escalateQuestion;
      },
      set escalateQuestion(value) {
        store.escalateQuestion = value;
      },
      get questionReminders() {
        return store.questionReminders;
      },
      get retryTimers() {
        return store.retryTimers;
      },
      nativeSessionKey: (...args) => store.nativeSessionKey(...args),
      get stateUnreadable() {
        return store.stateUnreadable;
      },
      set stateUnreadable(value) {
        store.stateUnreadable = value;
      },
      seatWithSession: (...args) => store.seatWithSession(...args),
      get validateOwner() {
        return store.validateOwner;
      },
      retireReboundWatches: (...args) => store.retireReboundWatches(...args),
      get onReadopted() {
        return store.onReadopted;
      },
      get state() {
        return store.state;
      },
      set state(value) {
        store.state = value;
      },
      get controllers() {
        return store.controllers;
      },
      save: (...args) => store.save(...args),
      get projectContexts() {
        return store.projectContexts;
      },
      get piSeatModel() {
        return store.piSeatModel;
      },
      launchHeld: (...args) => store.launchHeld(...args),
      get hireReceipts() {
        return store.hireReceipts;
      },
      get projectHires() {
        return store.projectHires;
      },
      hireAttempt: (...args) => store.hireAttempt(...args),
      get githubOrigin() {
        return store.githubOrigin;
      },
      legacyProjectHire: (...args) => store.legacyProjectHire(...args),
      projectHireProof: (...args) => store.projectHireProof(...args),
      get hireDefaults() {
        return store.hireDefaults;
      },
      chooseHireHarness: (...args) => store.chooseHireHarness(...args),
      get hireDefaultPolicies() {
        return store.hireDefaultPolicies;
      },
      get hireHarnessReasons() {
        return store.hireHarnessReasons;
      },
      get projectPolicy() {
        return store.projectPolicy;
      },
      spawnAdmittedSeat: (...args) => store.spawnAdmittedSeat(...args),
      retireGoneProjectHires: (...args) => store.retireGoneProjectHires(...args),
      retireUnsentRemoteAt: (...args) => store.retireUnsentRemoteAt(...args),
      get activeProjectHires() {
        return store.activeProjectHires;
      },
      projectHireBlocker: (...args) => store.projectHireBlocker(...args),
      get projectAllocations() {
        return store.projectAllocations;
      },
      get projectLiveReuse() {
        return store.projectLiveReuse;
      },
      get projectRecoveryOnly() {
        return store.projectRecoveryOnly;
      },
      get workerAccountsReport() {
        return store.workerAccountsReport;
      },

      get resolveModel() {
        return store.resolveModel;
      },
      runProjectPolicy: (...args) => store.runProjectPolicy(...args),
      get projectPolicyQueue() {
        return store.projectPolicyQueue;
      },
      set projectPolicyQueue(value) {
        store.projectPolicyQueue = value;
      },
      get fleetResources() {
        return store.fleetResources;
      },
      admitProjectLaunch: (...args) => store.admitProjectLaunch(...args),
      get fleetHireTools() {
        return store.fleetHireTools;
      },
      get hireRefusal() {
        return store.hireRefusal;
      },
      resolveHireModels: (...args) => store.resolveHireModels(...args),
      get workHires() {
        return store.workHires;
      },
      performSpawnSeat: (...args) => store.performSpawnSeat(...args),
      get resumeStarts() {
        return store.resumeStarts;
      },
      get nativeLaunchPolicy() {
        return store.nativeLaunchPolicy;
      },
      get remoteHireReceipts() {
        return store.remoteHireReceipts;
      },
      retireCompletedHires: (...args) => store.retireCompletedHires(...args),
      assertRemoteHireAuthority: (...args) => store.assertRemoteHireAuthority(...args),
      retireGoneLocalHires: (...args) => store.retireGoneLocalHires(...args),
      retireUnsentRemoteHires: (...args) => store.retireUnsentRemoteHires(...args),
      get activeHires() {
        return store.activeHires;
      },
      get briefStateDir() {
        return store.briefStateDir;
      },
      bindHireOwner: (...args) => store.bindHireOwner(...args),
      observeHireIdentity: (...args) => store.observeHireIdentity(...args),
      launch: (...args) => store.launch(...args),
      startSeat: (...args) => store.startSeat(...args),
      resumeSeat: (...args) => store.resumeSeat(...args),
      get remoteLaunches() {
        return store.remoteLaunches;
      },
      remoteClaim: (...args) => store.remoteClaim(...args),
      remoteAdoption: (...args) => store.remoteAdoption(...args),
      adoptRemoteHire: (...args) => store.adoptRemoteHire(...args),
      adoptLocalHire: (...args) => store.adoptLocalHire(...args),
      settleNativeHireReceipt: (...args) => store.settleNativeHireReceipt(...args),
      shellOnlyPane: (...args) => store.shellOnlyPane(...args),
      localHireReceipt: (...args) => store.localHireReceipt(...args),
      abandonLocalHireReceipt: (...args) => store.abandonLocalHireReceipt(...args),
      recoverHireReceipt: (...args) => store.recoverHireReceipt(...args),
      get loadedAt() {
        return store.loadedAt;
      },
      unrecordedHireStale: (...args) => store.unrecordedHireStale(...args),
      releaseSettledHireAllocation: (...args) => store.releaseSettledHireAllocation(...args),
      get channelReceipt() {
        return store.channelReceipt;
      },
      commitRemoteLaunch: (...args) => store.commitRemoteLaunch(...args),
      get resumeInventory() {
        return store.resumeInventory;
      },
      get remoteWorkspace() {
        return store.remoteWorkspace;
      },
      get claudeAccounts() {
        return store.claudeAccounts;
      },
      get accounts() {
        return store.accounts;
      },
      nativeCheckout: (...args) => store.nativeCheckout(...args),
      launchSeat: (...args) => store.launchSeat(...args),
      get hireCapacity() {
        return store.hireCapacity;
      },
      get seatAdapters() {
        return store.seatAdapters;
      },
      get remoteSeatAdapters() {
        return store.remoteSeatAdapters;
      },
      get piNativeEnabled() {
        return store.piNativeEnabled;
      },
      get workerAccounts() {
        return store.workerAccounts;
      },
      get accountHolds() {
        return store.accountHolds;
      },
      get skillBundle() {
        return store.skillBundle;
      },
      get workerSandbox() {
        return store.workerSandbox;
      },
      expectedHireTools: (...args) => store.expectedHireTools(...args),
      hostedPiModel: (...args) => store.hostedPiModel(...args),
      get maximumTrustMode() {
        return store.maximumTrustMode;
      },
      admitResourceMutation: (...args) => store.admitResourceMutation(...args),
      forwardNativeQuestion: (...args) => store.forwardNativeQuestion(...args),
      agentWithSession: (...args) => store.agentWithSession(...args),
      startupFailure: (...args) => store.startupFailure(...args),
      get hiredRestarts() {
        return store.hiredRestarts;
      },
      restoredRetirementGuard: (...args) => store.restoredRetirementGuard(...args),
      closeSeat: (...args) => store.closeSeat(...args),
      untrackSeat: (...args) => store.untrackSeat(...args),
      spawnSeat: (...args) => store.spawnSeat(...args),
      get seatControllers() {
        return store.seatControllers;
      },
      get headSeats() {
        return store.headSeats;
      },
      ensureSummaryWatch: (...args) => store.ensureSummaryWatch(...args),
      runSeat: (...args) => store.runSeat(...args),
      stopSummaryWatch: (...args) => store.stopSummaryWatch(...args),
      get seatStatuses() {
        return store.seatStatuses;
      },
      get seatSummaries() {
        return store.seatSummaries;
      },
      get transcriptSeats() {
        return store.transcriptSeats;
      },
      harvestClaim: (...args) => store.harvestClaim(...args),
      adapterStatus: (...args) => store.adapterStatus(...args),
      watchOwner: (...args) => store.watchOwner(...args),
      publishSeatStatus: (...args) => store.publishSeatStatus(...args),
      publishSeatTranscript: (...args) => store.publishSeatTranscript(...args),
      publishSeatSummary: (...args) => store.publishSeatSummary(...args),
      get summariesPath() {
        return store.summariesPath;
      },
      followTranscript: (...args) => store.followTranscript(...args),
      get watchingSummaries() {
        return store.watchingSummaries;
      },
      set watchingSummaries(value) {
        store.watchingSummaries = value;
      },
      get summaryWatchIntervalMs() {
        return store.summaryWatchIntervalMs;
      },
      get onSummariesChanged() {
        return store.onSummariesChanged;
      },
      run: (...args) => store.run(...args),
      remove: (...args) => store.remove(...args),
      endsOnNativeChange: (...args) => store.endsOnNativeChange(...args),
      get lastReply() {
        return store.lastReply;
      },
      retry: (...args) => store.retry(...args),
      retryWorking: (...args) => store.retryWorking(...args),
      nativeEnd: (...args) => store.nativeEnd(...args),
      settle: (...args) => store.settle(...args),
      get onWorkerSettled() {
        return store.onWorkerSettled;
      },
      get awaitRound() {
        return store.awaitRound;
      },
      get settlementsPath() {
        return store.settlementsPath;
      },
      writeSidecar: (...args) => store.writeSidecar(...args),
      settlements: (...args) => store.settlements(...args),
      recordSettlement: (...args) => store.recordSettlement(...args),
    };
  }
}
