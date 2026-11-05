import type { createHerdrWatchDelivery } from "./herdr-watch-delivery.ts";
import type { createHerdrWatchOwnership } from "./herdr-watch-ownership.ts";
import type { createHerdrWatchObservation } from "./herdr-watch-observation.ts";
import type { SeatExitGuard } from "@clankie/agent-hosts";
import { HiredSeatRestarts } from "./hired-seat-restart.ts";
import { type FleetResourceRuntime } from "../fleet-resource-runtime.ts";
import { ProjectHires, type ProjectHireProcessProof } from "./project-hires.ts";
import type { RetirementGuard } from "./retirement-guard.ts";
import { HireOwners } from "./hire-owners.ts";
import { type ConversationAuthority, type ConversationOwner } from "./conversation-owner.ts";
import { DeliveryFence, type UncertainReceipt } from "./delivery-fence.ts";
import { createFleetSeatControl } from "./fleet-seat-control.ts";
import { type PeerDeliveryOptions } from "./peer-seat-messages.ts";
import type { MachineAccessFence } from "../machine-access.ts";
import type { SavedAgentSession } from "../agent-sessions.ts";
import type { HarnessSeatAdapter, SeatQuestion, SeatRef } from "@clankie/agent-hosts";
import { type CodexAccount } from "@clankie/settings";
import { type HireProfile, type SpawnOperatorSeat as HireRequest } from "@clankie/protocol";
import { type FleetSeatDelivery } from "./fleet-seat.ts";
import { type HerdrAgentSummary } from "./herdr-summaries.ts";
import type { RemoteHireClaim, RemoteHireReceipts } from "../remote-hire-receipts.ts";
import {
  type MachineWorkerAccounts,
  type WorkerAccountHarness,
  type WorkerAccountHold,
} from "./harness-accounts.ts";
import type { HireReceiptSettlement, HireRecoveryEvidence } from "@clankie/protocol";
import { type WorkerSandbox } from "../worker-sandbox.ts";
import { type HerdrSeatTranscript } from "./herdr-transcript.ts";
import {
  type HerdrWatchEnd,
  type HerdrWatchSettlement,
  type HerdrWatchRecord,
  type PersistedHerdrWatches,
  type HerdrAgentSnapshot,
  type SpawnOperatorSeat,
  type HerdrWatchRunner,
  type HireAuthority,
  type AdoptHire,
  type InternalWake,
  type ProjectSeat,
  type HerdrSeatSpawnResult,
  type HerdrSeatSpawnFailure,
  type PiSeatModel,
  type NativeLaunchPolicy,
  type ProjectHirePolicy,
} from "./herdr-watch-types.ts";

/** Live store state and cross-domain operations; getters never snapshot authority. */
export interface HerdrWatchContext {
  readonly hiredRestarts: HiredSeatRestarts;
  readonly runner: HerdrWatchRunner;
  readonly hireOwners: HireOwners;
  wake: InternalWake | undefined;
  projectSeat: ProjectSeat | undefined;
  state: PersistedHerdrWatches;
  launch(record: HerdrWatchRecord): void;
  readonly seatControl: ReturnType<typeof createFleetSeatControl>;
  nativeOwner(agent: HerdrAgentSnapshot): ConversationOwner | undefined;
  seatClaim(agent: HerdrAgentSnapshot): { owner: ConversationOwner; hired: boolean } | undefined;
  scopedDelivery(
    id: string,
    conversationId: string,
    ownerSettlement?: boolean,
  ): ReturnType<ReturnType<typeof createHerdrWatchDelivery>["scopedDelivery"]>;
  closed: boolean;
  readRoomReply(seatId: string): ReturnType<ReturnType<typeof createHerdrWatchDelivery>["readRoomReply"]>;
  readonly seatTranscriptTailMs: number;
  readonly path: string;
  cacheNativeChat(path: string, transcript: HerdrSeatTranscript): void;
  readNativeChat(
    seatId: string,
    previous?: HerdrAgentSnapshot,
  ): Promise<
    | {
        agent: HerdrAgentSnapshot;
        transcript: HerdrSeatTranscript;
      }
    | undefined
  >;
  readSeatReply(
    agent: HerdrAgentSnapshot,
    source: "visible" | "recent-unwrapped",
  ): Promise<string | undefined>;
  nativeTaskObservation(
    seatId: string,
    holderId?: string,
  ): Promise<{ binding: string; status: string; queueSupported: boolean } | undefined>;
  deliverToSeat(
    seatId: string,
    text: string,
    uncontrolled?: (attempt?: PeerDeliveryOptions) => Promise<FleetSeatDelivery>,
    options?: PeerDeliveryOptions,
  ): Promise<FleetSeatDelivery>;
  readonly requireWorkerAccess: ((fleet?: string) => Promise<void | MachineAccessFence>) | undefined;
  watchHiredSeat(
    seatId: string,
    occupantId: string,
    owner: ConversationOwner,
    start?: boolean,
    messageId?: string,
  ): HerdrWatchRecord | undefined;
  watching: (() => Promise<boolean>) | undefined;
  permissionLeadAllowed: ((owner: ConversationOwner) => Promise<boolean>) | undefined;
  questionGate:
    | ((agent: HerdrAgentSnapshot, question: SeatQuestion) => Promise<"allow" | "lead" | "owner">)
    | undefined;
  ownerMustAnswer(
    owner: ConversationOwner,
    agent: HerdrAgentSnapshot,
    question: SeatQuestion,
  ): Promise<boolean>;
  escalateToOwner(
    owner: ConversationOwner,
    agent: HerdrAgentSnapshot,
    question: SeatQuestion,
    guard: () => Promise<void>,
    asked?: () => void,
  ): Promise<void>;
  remindOpenQuestion(
    asked: HerdrAgentSnapshot,
    requestId: string | number,
    text: string,
    deferred: boolean,
  ): void;
  escalateQuestion:
    | ((
        owner: ConversationOwner,
        agent: HerdrAgentSnapshot,
        question: SeatQuestion,
        guard: () => Promise<void>,
      ) => Promise<void>)
    | undefined;
  readonly questionReminders: {
    readonly retryMs: number;
    readonly remindMs: number;
    readonly windowMs: number;
  };
  readonly retryTimers: Set<NodeJS.Timeout>;
  nativeSessionKey(agent: HerdrAgentSnapshot): string | undefined;
  stateUnreadable: boolean;
  seatWithSession(
    read: () => Promise<HerdrAgentSnapshot | undefined>,
  ): Promise<HerdrAgentSnapshot | undefined>;
  readonly validateOwner: ((owner: ConversationOwner) => Promise<boolean>) | undefined;
  retireReboundWatches(
    replaced: readonly { seatId?: string | undefined; occupantId?: string | undefined }[],
    current: HerdrAgentSnapshot,
  ): void;
  readonly onReadopted:
    | ((seat: { occupantId: string; title: string; harness: string; name?: string }) => void)
    | undefined;
  readonly controllers: Map<string, AbortController>;
  save(): void;
  readonly projectContexts: WeakMap<
    SpawnOperatorSeat,
    { projectId: string; projectName: string; authority?: ConversationAuthority }
  >;
  readonly piSeatModel: (() => Promise<PiSeatModel | undefined>) | undefined;
  launchHeld(
    input: {
      readonly fleet?: string | undefined;
      readonly workingDirectory: string;
      readonly harness?: string | undefined;
    },
    held: (key: string) => boolean,
    conservative?: boolean,
  ): boolean;
  readonly hireReceipts: DeliveryFence;
  readonly projectHires: ProjectHires;
  hireAttempt(seat: {
    readonly paneId: string;
  }): ReturnType<ReturnType<typeof createHerdrWatchOwnership>["hireAttempt"]>;
  readonly githubOrigin: (directory: string) => string | undefined;
  legacyProjectHire(
    fleet: string,
    pane: string,
  ): ReturnType<ReturnType<typeof createHerdrWatchOwnership>["legacyProjectHire"]>;
  projectHireProof(
    fleet: string,
    pane: string,
    proof?: ProjectHireProcessProof,
  ): ReturnType<ReturnType<typeof createHerdrWatchOwnership>["projectHireProof"]>;
  readonly hireDefaults: (() => Promise<HireProfile>) | undefined;
  chooseHireHarness(
    input: HireRequest,
    resume?: SavedAgentSession,
    policy?: import("@clankie/protocol/projects").ProjectHiringPolicy,
    work?: boolean,
    ownerHire?: ConversationAuthority["ownerHire"],
  ): Promise<
    { readonly harness: SpawnOperatorSeat["harness"]; readonly why?: string } | HerdrSeatSpawnResult
  >;
  readonly hireDefaultPolicies: WeakMap<SpawnOperatorSeat, string>;
  readonly hireHarnessReasons: WeakMap<SpawnOperatorSeat, string>;
  readonly projectPolicy: ProjectHirePolicy | undefined;
  spawnAdmittedSeat(
    input: SpawnOperatorSeat,
    subjectOverride?: string,
    brief?: string,
    resume?: SavedAgentSession,
    authority?: HireAuthority,
    adopt?: AdoptHire,
    flushAdoption?: () => Promise<void>,
    work?: boolean,
    leadFingerprint?: string,
  ): Promise<HerdrSeatSpawnResult>;
  retireGoneProjectHires(workingDirectory: string, guard: () => Promise<void>): Promise<void>;
  retireUnsentRemoteAt(
    input: {
      fleet?: string | undefined;
      workingDirectory: string;
      harness?: string | undefined;
      freshIntent?: { readonly id: string; readonly afterReceiptId: string } | undefined;
    },
    guard: () => Promise<void>,
    projectId?: string,
  ): Promise<void>;
  readonly activeProjectHires: Set<string>;
  projectHireBlocker(id: string): string;
  readonly projectAllocations: WeakMap<SpawnOperatorSeat, string>;
  readonly projectLiveReuse: WeakSet<SpawnOperatorSeat>;
  readonly projectRecoveryOnly: WeakMap<SpawnOperatorSeat, string>;
  readonly workerAccountsReport: ((fleet?: string) => Promise<MachineWorkerAccounts>) | undefined;
  readonly resolveModel: ((harness: string, model: string) => Promise<string>) | undefined;
  runProjectPolicy(action: () => Promise<void>): Promise<void>;
  projectPolicyQueue: Promise<void>;
  readonly fleetResources: FleetResourceRuntime | undefined;
  admitProjectLaunch(
    input: SpawnOperatorSeat,
    dispatched?: boolean,
    authorityOverride?: ConversationAuthority,
  ): Promise<void>;
  readonly fleetHireTools: (() => Promise<readonly string[]>) | undefined;
  readonly hireRefusal: ((input: HireRequest) => Promise<string | undefined>) | undefined;
  resolveHireModels(input: SpawnOperatorSeat): Promise<SpawnOperatorSeat>;
  readonly workHires: WeakSet<SpawnOperatorSeat>;
  performSpawnSeat(
    input: SpawnOperatorSeat,
    subjectOverride?: string,
    brief?: string,
    resume?: SavedAgentSession,
    authority?: HireAuthority,
    adopt?: AdoptHire,
    flushAdoption?: () => Promise<void>,
    leadFingerprint?: string,
  ): Promise<HerdrSeatSpawnResult>;
  readonly resumeStarts: Map<string, Promise<void>>;
  readonly nativeLaunchPolicy: NativeLaunchPolicy | undefined;
  readonly remoteHireReceipts: RemoteHireReceipts | undefined;
  retireCompletedHires(
    fleet: string,
    scope: { baseKey?: string; paneId?: string },
    guard?: () => Promise<void>,
  ): Promise<void>;
  assertRemoteHireAuthority(
    input: SpawnOperatorSeat,
    key: string | undefined,
    authority: HireAuthority | undefined,
  ): Promise<void>;
  retireGoneLocalHires(baseKey: string, guard: () => Promise<void>): Promise<void>;
  retireUnsentRemoteHires(baseKey: string, guard: () => Promise<void>): Promise<void>;
  readonly activeHires: Set<string>;
  readonly briefStateDir: string | undefined;
  bindHireOwner(agent: HerdrAgentSnapshot, input: SpawnOperatorSeat, authority: HireAuthority): Promise<void>;
  observeHireIdentity(
    receiptKey: string | undefined,
    agent: HerdrAgentSnapshot,
    input: SpawnOperatorSeat,
    authority?: HireAuthority,
    requireProof?: boolean,
    preparedProof?: ProjectHireProcessProof,
  ): Promise<void>;
  startSeat(
    input: SpawnOperatorSeat,
    subjectOverride?: string,
    brief?: string,
    resume?: SavedAgentSession,
    receiptKey?: string,
    authority?: HireAuthority,
  ): Promise<HerdrSeatSpawnResult>;
  resumeSeat(
    input: SpawnOperatorSeat,
    session: SavedAgentSession,
    brief?: string,
    receiptKey?: string,
    authority?: HireAuthority,
  ): Promise<HerdrSeatSpawnResult>;
  readonly remoteLaunches: Set<string>;
  remoteClaim(
    key: string,
    receipt: import("./delivery-fence.ts").UncertainReceipt,
  ): RemoteHireClaim | undefined;
  remoteAdoption(id: string): boolean;
  adoptRemoteHire(id: string, guard: () => Promise<void>): Promise<HireReceiptSettlement>;
  adoptLocalHire(id: string, guard: () => Promise<void>): Promise<HireReceiptSettlement>;
  settleNativeHireReceipt(
    receiptId: string,
    guard?: () => Promise<void>,
    disposition?: "not-launched" | "delivered" | "abandoned" | "abandoned-unknown" | "release-allocation",
    expectedAllocation?: NonNullable<ReturnType<ProjectHires["recoveryCandidate"]>>,
  ): Promise<HireReceiptSettlement>;
  shellOnlyPane(pane: HerdrAgentSnapshot): Promise<number | string>;
  localHireReceipt(receiptId: string): boolean;
  abandonLocalHireReceipt(receiptId: string, guard: () => Promise<void>): Promise<HireReceiptSettlement>;
  recoverHireReceipt(
    receiptId: string,
    guard: () => Promise<void>,
    disposition: "delivered" | "abandoned" | "abandoned-unknown",
  ): Promise<HireReceiptSettlement>;
  readonly loadedAt: number;
  unrecordedHireStale(beganAt: number | undefined): boolean;
  releaseSettledHireAllocation(
    receiptKey: string,
    paneId: string | undefined,
    guard: () => Promise<void>,
    abandoned: HireReceiptSettlement & { state: "abandoned" },
  ): Promise<HireReceiptSettlement>;
  readonly channelReceipt:
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
  commitRemoteLaunch(key?: string, input?: SpawnOperatorSeat): Promise<void>;
  readonly resumeInventory: ((fleet?: string) => Promise<readonly HerdrAgentSnapshot[]>) | undefined;
  readonly remoteWorkspace: ((fleet: string, directory: string) => Promise<boolean>) | undefined;
  readonly claudeAccounts: (() => Promise<readonly CodexAccount[]>) | undefined;
  readonly accounts: () => Promise<readonly CodexAccount[]>;
  nativeCheckout(workingDirectory: string): string;
  launchSeat(
    input: SpawnOperatorSeat,
    chosen: { account?: string; reason?: string },
    subjectOverride?: string,
    brief?: string,
    resume?: SavedAgentSession,
    receiptKey?: string,
    authority?: HireAuthority,
  ): Promise<HerdrSeatSpawnResult>;
  readonly hireCapacity:
    | (() => Promise<{ readonly live: number; readonly limit: number } | undefined>)
    | undefined;
  readonly seatAdapters: ReadonlyMap<string, HarnessSeatAdapter>;
  readonly remoteSeatAdapters:
    | ((fleet: string) => ReadonlyMap<string, HarnessSeatAdapter> | undefined)
    | undefined;
  readonly piNativeEnabled: (() => Promise<boolean>) | undefined;
  readonly workerAccounts:
    | ((fleet: string | undefined, harness: WorkerAccountHarness) => Promise<MachineWorkerAccounts>)
    | undefined;
  readonly accountHolds: (() => Promise<readonly WorkerAccountHold[]>) | undefined;
  readonly skillBundle: { repoRoot: string; stateDir: string } | undefined;
  readonly workerSandbox: (() => Promise<WorkerSandbox | undefined>) | undefined;
  expectedHireTools(input: SpawnOperatorSeat): Promise<readonly string[]>;
  hostedPiModel(requested: string | undefined): Promise<string | undefined>;
  readonly maximumTrustMode: (() => Promise<boolean>) | undefined;
  admitResourceMutation(input: SpawnOperatorSeat, authority?: HireAuthority): Promise<void>;
  forwardNativeQuestion(ref: SeatRef, question: SeatQuestion): Promise<void>;
  agentWithSession(paneId: string, waitMs: number): Promise<HerdrAgentSnapshot>;
  startupFailure(
    paneId: string,
    harness: string,
    detail: string,
    reason?: HerdrSeatSpawnFailure["reason"],
  ): Promise<HerdrSeatSpawnFailure>;
  restoredRetirementGuard(agent: HerdrAgentSnapshot): Promise<RetirementGuard>;
  closeSeat(seatId: string, guard?: SeatExitGuard, nativeOnly?: boolean): Promise<boolean>;
  untrackSeat(seatId: string): void;
  spawnSeat(
    inputRequest: HireRequest,
    subjectOverride?: string,
    brief?: string,
    resume?: SavedAgentSession,
    authority?: HireAuthority,
    adopt?: AdoptHire,
    flushAdoption?: () => Promise<void>,
    taskBrief?: boolean,
    leadFingerprint?: string,
  ): Promise<HerdrSeatSpawnResult>;
  readonly seatControllers: Map<string, AbortController>;
  readonly headSeats: Set<string>;
  ensureSummaryWatch(): void;
  runSeat(seatId: string, signal: AbortSignal, mode: "status" | "head"): Promise<void>;
  stopSummaryWatch(): void;
  readonly seatStatuses: Map<string, string>;
  readonly seatSummaries: Map<string, string>;
  readonly transcriptSeats: Set<string>;
  harvestClaim(
    terminalId: string,
    occupantId: string,
    messageId: string,
  ): ReturnType<ReturnType<typeof createHerdrWatchObservation>["harvestClaim"]>;
  adapterStatus(agent: HerdrAgentSnapshot): Promise<string | undefined>;
  watchOwner(record: HerdrWatchRecord): ConversationOwner | undefined;
  publishSeatStatus(seatId: string, status: string): void;
  publishSeatTranscript(seatId: string, agent: HerdrAgentSnapshot): Promise<boolean>;
  publishSeatSummary(
    seatId: string,
    paneId: string,
    summaries: Readonly<Record<string, HerdrAgentSummary>>,
  ): void;
  readonly summariesPath: string;
  followTranscript(
    seatId: string,
    current: HerdrAgentSnapshot,
    changed: Promise<HerdrAgentSnapshot>,
    signal: AbortSignal,
  ): Promise<HerdrAgentSnapshot>;
  watchingSummaries: boolean;
  readonly summaryWatchIntervalMs: number;
  readonly onSummariesChanged: () => void;
  run(record: HerdrWatchRecord, signal: AbortSignal): Promise<void>;
  remove(id: string): void;
  endsOnNativeChange(record: HerdrWatchRecord, live: HerdrAgentSnapshot | undefined): boolean;
  readonly lastReply: ((agent: HerdrAgentSnapshot) => Promise<string | undefined>) | undefined;
  retry(record: HerdrWatchRecord, delayMs?: number): void;
  retryWorking(
    record: HerdrWatchRecord,
    pane: HerdrAgentSnapshot | undefined,
    signal: AbortSignal,
  ): Promise<void>;
  nativeEnd(
    record: HerdrWatchRecord,
    live: HerdrAgentSnapshot | undefined,
  ): HerdrWatchEnd | "unread" | undefined;
  settle(record: HerdrWatchRecord, outcome: HerdrWatchSettlement["outcome"], receiptId?: string): void;
  readonly onWorkerSettled: ((seatId: string, occupantId: string) => void) | undefined;
  readonly awaitRound: ((conversationId: string, signal: AbortSignal) => Promise<void>) | undefined;
  readonly settlementsPath: string;
  writeSidecar(path: string, value: unknown): void;
  settlements(): readonly HerdrWatchSettlement[];
  recordSettlement(
    record: HerdrWatchRecord,
    outcome: HerdrWatchSettlement["outcome"],
    receiptId?: string,
  ): void;
}
