import { readFleetSeatCapabilities } from "./fleet-seat-capabilities.ts";
import {
  fleetProjectionDiagnostics,
  type FleetProjectionDiagnostics,
} from "./fleet-projection-diagnostics.ts";
import { CheckoutObservationCache } from "./checkout-observation-cache.ts";
import { SeatEfficiencyStore } from "./seat-efficiency.ts";
import {
  readSeatCommitClaim,
  readSeatTelemetry,
  readSeatActivity,
  type SeatCommitBaseline,
} from "./seat-telemetry.ts";
import { fleetRoundEvidence } from "./fleet-review.ts";
import { readClaudeSubagents, readCodexSubagents } from "@clankie/agent-transcript";
import {
  OPERATOR_FLEET_ROSTER_MAX,
  type OperatorFleetSeat,
  type WorkerReportRouting,
} from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative } from "node:path";
import { splitFleetQualified, type HerdrFleet } from "../herdr-fleet.ts";
import { createAgentWorkStore, withSeatWork } from "./agent-work.ts";
import { type CaptainOptions } from "./captain-types.ts";
import { createWorkerReports } from "./captain-worker-reports.ts";
import { createHealthAlerts } from "./captain-health-alerts.ts";
import { createNativeSources } from "./captain-native-sources.ts";
import { createToolCatalogHealth } from "./captain-tool-catalog.ts";
import { type ConversationOwner } from "./conversation-owner.ts";
import { ConversationStore } from "./conversations.ts";
import type { CaptainDeps } from "./deps.ts";
import { Evaluator } from "./evaluator.ts";
import { parentSeatIds, type EdgeSeat } from "./fleet-edges.ts";
import {
  occupantIdForHerdrSession,
  FleetRosterLimitError,
  type ObservedHeadSeat,
  type ObservedFleetSeat,
} from "./herdr-census.ts";
import { FleetChangeClock } from "./herdr-fleet-changes.ts";
import { HerdrWatchStore, type HerdrAgentSnapshot } from "./herdr-watch.ts";
import { NextTurnMailbox } from "./next-turn-mailbox.ts";
import { FleetRoster } from "./fleet-roster.ts";
import {
  SeatIssueKeeper,
  liveSeatIssue,
  prepareSeatIssueAttribution,
  warnSeatIssueUnavailable,
} from "./seat-issue-status.ts";
import { PersonaStore } from "./personas.ts";
import { createRemoteCodexGoals } from "./remote-codex-goals.ts";
import { type SeatLedger } from "./seat-ledger.ts";
import { withSeatSubagents } from "./seat-subagents.ts";
import type { CreateOperatorServiceContext } from "./captain-operator-service.ts";
import type { HerdrWatchRunner } from "./herdr-watch.ts";
import type { StanceStore } from "./stances.ts";
import type { ObservedFleet } from "./herdr-census.ts";

export interface FleetProjectionContext {
  readonly options: CaptainOptions;
  readonly deps: CaptainDeps;
  readonly fleetChanges: FleetChangeClock;
  readonly observeFleet: (
    localOnly?: boolean,
    onPending?: (source: string, pending: boolean, outcome?: "ok" | "error") => void,
    diagnostics?: FleetProjectionDiagnostics,
  ) => Promise<ObservedFleet>;
  readonly personas: PersonaStore;
  readonly settingsStore: SettingsStore;
  readonly bindHeadSeat: (head: ObservedHeadSeat | undefined) => void;
  readonly evaluator: Evaluator;
  readonly conversations: ConversationStore;
  readonly conversationGoal: CreateOperatorServiceContext["conversationGoal"];
  readonly conversationAssignment: CreateOperatorServiceContext["conversationAssignment"];
  readonly herdrWatches: HerdrWatchStore;
  readonly agentWork: ReturnType<typeof createAgentWorkStore>;
  readonly seatMessageReceiver: (native: HerdrAgentSnapshot) => {
    state: "unverified" | "live" | "next-turn-only";
    detail: string;
  };
  readonly nextTurnMailboxes: NextTurnMailbox;
  readonly publishWaitingNotice: (seat: string, binding: string | undefined, pane: string) => Promise<void>;
  readonly seatSubjects: Map<string, string>;
  readonly seatByPersona: Map<string, string>;
  readonly stances: StanceStore;
  readonly seatLedger: SeatLedger;
  readonly validateConversationOwner: (owner: ConversationOwner) => Promise<boolean>;
  readonly herdrRunner: HerdrWatchRunner;
  readonly catalogIdentity: ReturnType<typeof createToolCatalogHealth>["catalogIdentity"];
  readonly currentCatalogHealth: ReturnType<typeof createToolCatalogHealth>["currentCatalogHealth"];
  readonly seatLeadOwners: WeakMap<
    OperatorFleetSeat,
    { owner: ConversationOwner; admitted: boolean; observed: ObservedFleetSeat }
  >;
  readonly initialCommitBaseline: (observed: ObservedFleetSeat) => Promise<SeatCommitBaseline | undefined>;
  readonly observationIdentity: (observed: ObservedFleetSeat) => string;
  readonly observedCommitBaselines: Map<string, Promise<SeatCommitBaseline | undefined>>;
  readonly preparedTelemetry: Set<string>;
  readonly seatEfficiency: SeatEfficiencyStore;
  readonly issueStatus: SeatIssueKeeper;
  readonly fleetRoster: FleetRoster;
  readonly waitingRosterSeats: () => Set<string>;
  /** Read at call time: the captain replaces the linked fleets as they change (ADR 0325). */
  readonly remoteFleets: readonly HerdrFleet[];
  /** Read and written at call time: the captain's live seat state, shared with hiring and delivery (ADR 0325). */
  liveSeats: readonly OperatorFleetSeat[];
  liveEdgeSeats: readonly EdgeSeat[];
  efficiencyFingerprint: string;
  /** Read at call time: the captain builds these after the projection (ADR 0325). */
  readonly observedAgent: ReturnType<typeof createNativeSources>["observedAgent"];
  readonly inboundBinding: ReturnType<typeof createNativeSources>["inboundBinding"];
  readonly workerReportRoute: ReturnType<typeof createNativeSources>["workerReportRoute"];
  readonly reportSummaries: ReturnType<typeof createWorkerReports>["reportSummaries"];
  readonly observeReportFailureAlerts: ReturnType<typeof createHealthAlerts>["observeReportFailureAlerts"];
}

/**
 * Fleet projection: the shared census, fleet refresh, and the projection of
 * observed seats into the operator roster with their work, goals, catalogs and
 * efficiency (moved from the captain, ADR 0325).
 */
export function createFleetProjection(ctx: FleetProjectionContext) {
  const {
    options,
    deps,
    fleetChanges,
    observeFleet,
    personas,
    settingsStore,
    bindHeadSeat,
    evaluator,
    conversations,
    conversationGoal,
    conversationAssignment,
    herdrWatches,
    agentWork,
    seatMessageReceiver,
    nextTurnMailboxes,
    publishWaitingNotice,
    seatSubjects,
    seatByPersona,
    stances,
    seatLedger,
    validateConversationOwner,
    herdrRunner,
    catalogIdentity,
    currentCatalogHealth,
    seatLeadOwners,
    initialCommitBaseline,
    observationIdentity,
    observedCommitBaselines,
    preparedTelemetry,
    seatEfficiency,
    issueStatus,
    fleetRoster,
    waitingRosterSeats,
  } = ctx;

  let seatSubagents = "";
  const withRemoteGoals = createRemoteCodexGoals({ shell: (fleet) => deps.fleets?.shell?.(fleet) });
  let seatWork = "";
  let seatActivities = "";
  let captainGoals = "";

  const FLEET_FRESH_MS = 1000;
  const FLEET_READ_TIMEOUT_MS = 5_000;
  // Under the five-second client deadline of `clankie herdr agent list` and doctor.
  const ROSTER_READ_TIMEOUT_MS = 3_000;
  // Under the 30-second abort of `clankie agents efficiency`, with room for the
  // response; a remote fleet's own transport deadline can exceed it (LOCAL-VUH-19).
  const FLEET_EFFICIENCY_DEADLINE_MS = 25_000;
  let lastProjectedSeats: readonly OperatorFleetSeat[] = [];
  const pendingFleetSources = new Set<string>();
  // Sources whose latest census failed; their seats are unknown, not absent.
  const unansweredFleetSources = new Set<string>();
  let fleetRefresh: Promise<readonly OperatorFleetSeat[]> | undefined;
  let refreshedFleet:
    | { seats: readonly OperatorFleetSeat[]; cursor: string; completedAt: number }
    | undefined;

  /** Share roster work, never the fresh native proofs used to authorize effects. */
  async function refreshFleet({ force = false }: { force?: boolean } = {}): Promise<
    readonly OperatorFleetSeat[]
  > {
    const preceding = fleetRefresh;
    if (preceding !== undefined) {
      if (!force) return preceding;
      // A post-mutation read must start after this request, not join a census
      // that may already have observed the old occupant. Parallel force callers
      // waiting on the same earlier flight share its one subsequent refresh.
      // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); an unreadable observation leaves the projection as it was.
      await preceding.catch(() => undefined);
      if (fleetRefresh !== undefined) return fleetRefresh;
    }
    if (
      !force &&
      refreshedFleet !== undefined &&
      refreshedFleet.cursor === fleetChanges.current() &&
      performance.now() - refreshedFleet.completedAt < FLEET_FRESH_MS
    )
      return refreshedFleet.seats;
    const cursor = fleetChanges.current();
    const pending = observeFleetProjection();
    fleetRefresh = pending;
    try {
      const seats = await pending;
      // A mutation or native event during projection must not be stamped onto
      // older seats. Initial projection changes also require one stabilizing
      // read, which fleetSnapshot already performs against its cursor.
      refreshedFleet =
        cursor === fleetChanges.current() ? { seats, cursor, completedAt: performance.now() } : undefined;
      return seats;
    } catch (error) {
      refreshedFleet = undefined;
      throw error;
    } finally {
      if (fleetRefresh === pending) fleetRefresh = undefined;
    }
  }

  // Catalog coordination shares one census per fleet cursor (VUH-2391): every
  // Herdr event and fleet mutation moves the cursor, so an answer is never
  // older than the last change it could have missed. Effects that need fresh
  // native proof still take their own census.
  let sharedCensus:
    | { cursor: string; fleet: ReturnType<typeof observeFleet>; completedAt?: number }
    | undefined;
  function observeSharedFleet(): ReturnType<typeof observeFleet> {
    const cursor = fleetChanges.current();
    if (
      sharedCensus?.cursor === cursor &&
      (sharedCensus.completedAt === undefined ||
        performance.now() - sharedCensus.completedAt < FLEET_FRESH_MS)
    )
      return sharedCensus.fleet;
    const fleet = observeFleet();
    const entry: NonNullable<typeof sharedCensus> = { cursor, fleet };
    sharedCensus = entry;
    fleet.then(
      () => (entry.completedAt = performance.now()),
      () => {
        if (sharedCensus === entry) sharedCensus = undefined;
      },
    );
    return fleet;
  }

  const checkoutObservations = new CheckoutObservationCache();
  async function enrichCheckoutSeats(
    seats: readonly OperatorFleetSeat[],
  ): Promise<readonly OperatorFleetSeat[]> {
    return Promise.all(
      seats.map(async (seat) => {
        if (seat.fleet !== undefined || !seat.workingDirectory) return seat;
        const checkout = await checkoutObservations.observe(seat.workingDirectory);
        return checkout ? { ...seat, checkout } : seat;
      }),
    );
  }
  async function observeFleetProjection(): Promise<readonly OperatorFleetSeat[]> {
    const diagnostics = fleetProjectionDiagnostics();
    try {
      const seats = await observeTimedFleetProjection(diagnostics);
      diagnostics.complete("ok");
      return seats;
    } catch (error) {
      diagnostics.complete("error");
      throw error;
    }
  }
  async function observeTimedFleetProjection(
    diagnostics: FleetProjectionDiagnostics,
  ): Promise<readonly OperatorFleetSeat[]> {
    await diagnostics.measure("settings_binding", () => personas.ready(settingsStore));
    // A seat closed after this read may still be listed; the issue keeper ignores it (VUH-2924).
    const censusAt = Date.now();
    const fleet = await observeFleet(
      false,
      (source, pending, outcome) => {
        diagnostics.census(source, pending, outcome);
        if (pending) pendingFleetSources.add(source);
        else pendingFleetSources.delete(source);
        if (outcome === "error") unansweredFleetSources.add(source);
        else if (outcome === "ok") unansweredFleetSources.delete(source);
      },
      diagnostics,
    );
    const stopGoalStatus = diagnostics.start("goal_status");
    if (fleet.seats.length > OPERATOR_FLEET_ROSTER_MAX) throw new FleetRosterLimitError(fleet.seats.length);
    bindHeadSeat(fleet.head);
    evaluator.observeFleet(fleet.seats);
    const goalList = await conversations.serve({ op: "list", schemaVersion: 1 });
    const nextGoals =
      goalList.op === "list"
        ? JSON.stringify(
            goalList.conversations.map((conversation) => [
              conversation.conversationId,
              conversationGoal(conversation.conversationId),
              conversationAssignment(conversation.conversationId),
            ]),
          )
        : "";
    if (nextGoals !== captainGoals) {
      captainGoals = nextGoals;
      fleetChanges.touch();
    }
    let workSeats: readonly OperatorFleetSeat[];
    if (options.nativeCensusRunner) {
      workSeats = personas.reconcile(fleet.seats, (seat) => herdrWatches.hireTitle(seat));
    } else {
      const subagents = await diagnostics.measure("subagents", () =>
        withSeatSubagents(
          personas.reconcile(fleet.seats, (seat) => herdrWatches.hireTitle(seat)),
          fleet.seats,
          (seat) =>
            conversations.conversationIdForPersona(seat.personaId) !== undefined ||
            conversations.conversationIdForSeat(seat.seatId) !== undefined,
          undefined,
          async (session) =>
            session.kind === "id" ? deps.agentSessions?.subagents?.(`local:${session.value}`) : undefined,
        ),
      );
      const work = withSeatWork(subagents, fleet.seats, agentWork);
      workSeats = await diagnostics.measure("remote_goals", () =>
        withRemoteGoals(work, fleet.seats, ctx.remoteFleets),
      );
    }
    const seats = await diagnostics.measure("native_status", () =>
      herdrWatches.withNativeStatus(workSeats, fleet.seats),
    );
    stopGoalStatus();
    // Live proof is refreshed asynchronously. Missing census or an untracked
    // head never establishes that an original process exited.
    // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); an unreadable observation leaves the projection as it was.
    void options.fleetResources?.observeSeats(fleet.seats).catch(() => undefined);
    const capabilitySeats = seats.map((seat) => fleet.seats.find((entry) => entry.seatId === seat.seatId));
    const capabilities = await readFleetSeatCapabilities(
      capabilitySeats.map((observed) => (observed ? ctx.observedAgent(observed) : undefined)),
      (native) => diagnostics.measure("capability", () => herdrWatches.inputCapabilities(native)),
    );
    for (const [index, seat] of seats.entries()) {
      const observed = capabilitySeats[index];
      if (!observed) continue;
      const qualified = splitFleetQualified(observed.paneId);
      const fleetId = qualified?.fleet ?? "default";
      const pane = qualified?.id ?? observed.paneId;
      if (options.workerBridgeStatus) seat.workerTools = options.workerBridgeStatus(fleetId, pane);
      const native = ctx.observedAgent(observed);
      if (seat.harness === "claude") {
        seat.messageReceiver = seatMessageReceiver(native);
      }
      seat.inputCapabilities = capabilities[index]!;
      seat.waitingMessages = nextTurnMailboxes.waiting(
        observed.seatId,
        ctx.inboundBinding(ctx.observedAgent(observed)),
      );
      await diagnostics
        .measure("waiting_notice", () =>
          publishWaitingNotice(
            observed.seatId,
            ctx.inboundBinding(ctx.observedAgent(observed)),
            observed.paneId,
          ),
        )
        // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); an unreadable observation leaves the projection as it was.
        .catch(() => undefined);
      const pluginVersion = seat.workerTools?.pluginVersion;
      if (
        !qualified &&
        seat.harness === "codex" &&
        pluginVersion &&
        Number(pluginVersion.split(".")[0]) === 0 &&
        (Number(pluginVersion.split(".")[1]) < 6 ||
          (Number(pluginVersion.split(".")[1]) === 6 && Number(pluginVersion.split(".")[2]) < 5))
      ) {
        seat.workerTools = {
          ...seat.workerTools!,
          restartNeeded: true,
          remediation: `Restart needed: automatic legacy restart is disabled. The lead can close this seat when idle and hire a fresh worker. Retain the original thread evidence and settle original receipts without replay.`,
        };
      }
      const report = options.workerReportBridgeStatus?.(fleetId, pane);
      if (report) seat.workerReportBridge = report;
    }
    const nextWork = JSON.stringify(
      seats.map((seat) => [
        seat.goal,
        seat.assignment,
        seat.harnessBridge,
        seat.workerTools,
        seat.workerReportBridge,
        seat.waitingMessages,
        seat.messageReceiver,
        seat.inputCapabilities,
        seat.status,
        seat.summary,
      ]),
    );
    if (seatWork !== nextWork) {
      seatWork = nextWork;
      fleetChanges.touch();
    }
    // A subagent starting or finishing is a roster change the long poll reports.
    const nextSubagents = JSON.stringify(seats.map((seat) => seat.subagents ?? null));
    if (seatSubagents !== nextSubagents) {
      seatSubagents = nextSubagents;
      fleetChanges.touch();
    }
    ctx.liveEdgeSeats = fleet.seats.map((observed) => ({
      seatId: observed.seatId,
      paneId: observed.paneId,
      ...(observed.session === undefined ? {} : { occupantId: occupantIdForHerdrSession(observed.session) }),
      ...(observed.parentPaneId === undefined ? {} : { parentPaneId: observed.parentPaneId }),
    }));
    // The agent name a seat is sitting under. It is the persona's binding key,
    // so a move has to hire under the same one (ADR 0164).
    seatSubjects.clear();
    for (const observed of fleet.seats) seatSubjects.set(observed.seatId, observed.subject);
    const parents = parentSeatIds([...ctx.liveEdgeSeats, ...(fleet.head === undefined ? [] : [fleet.head])]);
    const names = new Map(
      personas.all(seats, () => undefined).map((persona) => [persona.personaId, persona.name]),
    );
    seatByPersona.clear();
    for (const seat of seats) {
      seatByPersona.set(seat.personaId, seat.seatId);
      if (
        conversations.conversationIdForPersona(seat.personaId) !== undefined ||
        conversations.conversationIdForSeat(seat.seatId) !== undefined
      )
        conversations.bindPersona(seat.personaId, seat.seatId, names.get(seat.personaId) ?? seat.title);
      herdrWatches.trackSeat(seat.seatId);
    }
    ctx.liveSeats = seats;
    const stopRouting = diagnostics.start("routing_catalog");
    const projected = await Promise.all(
      seats.map(async (seat) => {
        // A lapsed stance simply is not here, so no surface has to reason about
        // how old the thing it is drawing is (ADR 0148).
        const stance = stances.read(seat.seatId, seat.occupantId);
        // The ledger is the authority for what a seat has earned; the room reads
        // this and never keeps a score of its own (app ADR 0030).
        const lastOutcome = seatLedger.lastOutcome(seat.seatId);
        const parentSeatId = parents.get(seat.seatId);
        const observed = fleet.seats.find((entry) => entry.seatId === seat.seatId);
        const activity =
          observed === undefined
            ? undefined
            : await diagnostics.measure("activity", () => readSeatActivity(observed, seat.status, stance));
        let workerReportRouting: WorkerReportRouting | undefined;
        let leadOwner: ConversationOwner | undefined;
        let admitted = true;
        if (observed) {
          try {
            const route = await ctx.workerReportRoute(ctx.observedAgent(observed), fleet);
            workerReportRouting = route.diagnostic;
            leadOwner = herdrWatches.nativeOwner(ctx.observedAgent(observed));
            // A native-only report route uses global-default as a transport
            // fallback. It never makes that child an owned captain seat.
            if (leadOwner === undefined && route.diagnostic.source === "parent" && route.native === undefined)
              leadOwner = route.owner;
          } catch {
            workerReportRouting = {
              source: "refused",
              reason: "authority_unavailable",
              ...(observed.parentPaneId === undefined ? {} : { leadPaneId: observed.parentPaneId }),
            };
          }
        }
        if (observed && leadOwner === undefined) {
          // Same-thread historical hire proof can bring a reporting fault to
          // its lead for inspection. It grants no control or review writes.
          try {
            const original = ctx.observedAgent(observed);
            const retained = herdrWatches.retainedReportOwner(original);
            if (retained && (await validateConversationOwner(retained))) {
              // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); an unreadable observation leaves the projection as it was.
              const current = await herdrRunner.get(original.paneId).catch(() => undefined);
              if (
                current &&
                ctx.inboundBinding(current) === ctx.inboundBinding(original) &&
                JSON.stringify(herdrWatches.retainedReportOwner(current)) === JSON.stringify(retained)
              ) {
                leadOwner = retained;
                admitted = false;
                workerReportRouting = {
                  source: "refused",
                  reason: "authority_unavailable",
                  conversationId: retained.conversationId,
                };
              }
            }
          } catch {
            /* Conflicting historical claims confer no inspection attribution. */
          }
        }
        const claim =
          observed === undefined ? undefined : herdrWatches.seatClaim(ctx.observedAgent(observed));
        const result: OperatorFleetSeat = {
          ...seat,
          conversationId: conversations.conversationIdForPersona(seat.personaId),
          ...(claim === undefined
            ? {}
            : { owner: { conversationId: claim.owner.conversationId, hired: claim.hired } }),
          ...(stance === undefined ? {} : { stance }),
          ...(activity === undefined ? {} : { activity }),
          ...(lastOutcome === undefined ? {} : { lastOutcome }),
          ...(parentSeatId === undefined ? {} : { parentSeatId }),
          ...(workerReportRouting === undefined ? {} : { workerReportRouting }),
          ...(await (async () => {
            const identity = observed && catalogIdentity(observed, "worker");
            return identity ? { toolCatalog: await currentCatalogHealth(identity) } : {};
          })()),
          ...(observed === undefined
            ? {}
            : { workerReports: ctx.reportSummaries(undefined, ctx.observedAgent(observed)).slice(-100) }),
        };
        if (leadOwner && observed) seatLeadOwners.set(result, { owner: leadOwner, admitted, observed });
        return result;
      }),
    );
    stopRouting();
    const stopGit = diagnostics.start("git_enrichment");
    // Establish all native worktree claims once per occupant, including seats
    // led elsewhere. A shared worktree cannot attribute HEAD progress to one seat.
    const claims = await Promise.all(
      fleet.seats.map(async (observed) => {
        const baseline = await initialCommitBaseline(observed);
        return {
          observed,
          baseline,
          cwd:
            observed.fleet === undefined && observed.workingDirectory
              ? // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); an unreadable observation leaves the projection as it was.
                await realpath(observed.workingDirectory).catch(() => undefined)
              : undefined,
          current:
            baseline && observed.workingDirectory
              ? await readSeatCommitClaim(observed.workingDirectory, baseline)
              : undefined,
        };
      }),
    );
    const currentObservations = new Set(fleet.seats.map(observationIdentity));
    for (const identity of observedCommitBaselines.keys()) {
      if (!currentObservations.has(identity)) observedCommitBaselines.delete(identity);
    }
    for (const identity of preparedTelemetry) {
      if (!currentObservations.has(identity)) preparedTelemetry.delete(identity);
    }
    await Promise.all(
      projected.map(async (seat) => {
        const lead = seatLeadOwners.get(seat);
        if (!lead) return;
        let baseline = seatEfficiency.readCommitBaseline(seat.occupantId, lead.owner);
        if (!baseline) {
          baseline = claims.find((claim) => claim.observed.seatId === seat.seatId)?.baseline;
          if (baseline) seatEfficiency.setCommitBaseline(seat.occupantId, lead.owner, baseline);
        }
        const exclusive =
          baseline &&
          !claims.some(
            (claim) =>
              claim.observed.seatId !== seat.seatId &&
              (claim.baseline
                ? claim.baseline.worktreeRoot === baseline.worktreeRoot ||
                  (claim.baseline.commonDir === baseline.commonDir &&
                    (!claim.current || claim.current.branchRef === baseline.branchRef))
                : claim.cwd !== undefined &&
                  basename(baseline.commonDir) === ".git" &&
                  (() => {
                    // A local primary-checkout claim cannot earn commit credit,
                    // and cannot establish another branch's exclusivity either.
                    const within = relative(dirname(baseline.commonDir), claim.cwd);
                    return within !== ".." && !within.startsWith("../") && !isAbsolute(within);
                  })()),
          );
        seat.efficiency = seatEfficiency.observe({
          occupantId: seat.occupantId,
          seatId: seat.seatId,
          owner: lead.owner,
          status: seat.status,
          assignment: seat.assignment,
          goal: seat.goal,
          reportRoute: seat.workerReportRouting,
          reportBridge: seat.workerReportBridge,
          reports: ctx.reportSummaries(undefined, ctx.observedAgent(lead.observed), true),
          telemetry: await readSeatTelemetry(lead.observed, {
            commitBaseline: exclusive ? baseline : undefined,
          }),
        });
      }),
    );
    stopGit();
    for (const seat of projected) {
      const efficiency = seat.efficiency;
      if (!efficiency?.assignedDeliverable) continue;
      if (
        projected.some(
          (other) =>
            other.occupantId !== seat.occupantId &&
            JSON.stringify(seatLeadOwners.get(other)?.owner) ===
              JSON.stringify(seatLeadOwners.get(seat)?.owner) &&
            other.efficiency?.assignedDeliverable === efficiency.assignedDeliverable,
        )
      )
        efficiency.flags.push("overlap");
    }
    const nextActivities = JSON.stringify(projected.map((seat) => [seat.occupantId, seat.activity ?? null]));
    if (nextActivities !== seatActivities) {
      seatActivities = nextActivities;
      fleetChanges.touch();
    }
    const fingerprint = fleetRoundEvidence(projected).fingerprint;
    if (fingerprint !== ctx.efficiencyFingerprint) {
      ctx.efficiencyFingerprint = fingerprint;
      fleetChanges.touch();
    }
    ctx.liveSeats = projected;
    lastProjectedSeats = projected;
    ctx.observeReportFailureAlerts(projected);
    const stopIssues = diagnostics.start("issue_enrichment");
    const stopAttribution = diagnostics.start("issue_attribution");
    const batchProofs = new Map<string, ReturnType<NonNullable<typeof options.projectHireIdentityBatch>>>();
    if (options.projectHireIdentityBatch && deps.workItems?.prepareSeatIssueTracker) {
      const groups = new Map<string, { pane: string; nativeOccupantId: string | undefined }[]>();
      for (const seat of projected) {
        const observed = seatLeadOwners.get(seat)?.observed;
        if (!observed?.fleet || observed.fleet === "default") continue;
        const group = groups.get(observed.fleet) ?? [];
        group.push({
          pane: observed.paneId,
          nativeOccupantId: observed.session ? occupantIdForHerdrSession(observed.session) : undefined,
        });
        groups.set(observed.fleet, group);
      }
      for (const [fleet, group] of groups) {
        batchProofs.set(
          fleet,
          diagnostics
            .measure("issue_proof_remote", () => options.projectHireIdentityBatch!(fleet, group))
            .catch(() => new Map()),
        );
      }
    }
    const liveIssues: import("./seat-issue-status.ts").LiveSeatIssue[] = await Promise.all(
      projected.map(async (seat) => {
        const issue = liveSeatIssue(seat);
        try {
          const observed = seatLeadOwners.get(seat)?.observed;
          if (!observed || !deps.workItems?.prepareSeatIssueTracker)
            throw new Error("No verified hire tracker route.");
          const attribution = await prepareSeatIssueAttribution(
            {
              fleet: observed.fleet ?? "default",
              pane: observed.paneId,
              nativeOccupantId: observed.session ? occupantIdForHerdrSession(observed.session) : undefined,
            },
            {
              proof: (fleet, pane) =>
                diagnostics.measure(
                  fleet === "default" ? "issue_proof_local" : "issue_proof_remote",
                  async () =>
                    batchProofs.has(fleet)
                      ? (await batchProofs.get(fleet)!).get(pane)
                      : (options.projectHireIdentity?.(fleet, pane) ?? Promise.resolve(undefined)),
                ),
              watches: herdrWatches,
              workItems: { prepareSeatIssueTracker: deps.workItems.prepareSeatIssueTracker },
              projects: () =>
                diagnostics.measure(
                  "issue_project_membership",
                  async () => (await settingsStore.read()).projects,
                ),
            },
          );
          return { ...issue, attribution };
        } catch (error) {
          // Keep a refusal with this observed seat; never reuse a default connector.
          return {
            ...issue,
            attribution: {
              resolve: async () => {
                throw error;
              },
            },
          };
        }
      }),
    );
    // The operator head is intentionally outside the worker roster. Its native
    // children still hold work; do not mistake that presentation boundary for exit.
    if (fleet.head?.session && !options.nativeCensusRunner) {
      const head = fleet.head;
      const children = await diagnostics
        .measure("issue_head_assignments", async () =>
          head.harness === "codex"
            ? readCodexSubagents(head.session!)
            : head.harness === "claude"
              ? readClaudeSubagents(head.session!)
              : undefined,
        )
        // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); an unreadable observation leaves the projection as it was.
        .catch(() => undefined);
      liveIssues.push({
        seatId: fleet.head.seatId,
        title: "Clankie",
        keys: [],
        ownedKeys: [
          agentWork.read(fleet.head.occupantId)?.issue?.itemId,
          ...(children?.recent ?? [])
            .filter((child) => child.status === "running")
            .map((child) => child.label),
        ],
      });
    }
    stopAttribution();
    await diagnostics
      .measure("issue_keeper", () => issueStatus.observe(liveIssues, censusAt))
      .then((results) => {
        for (const result of results) if (result.outcome === "failed") warnSeatIssueUnavailable(result);
      });
    stopIssues();
    fleetRoster.project(
      {
        schemaVersion: 1,
        cursor: fleetChanges.current(),
        seats: [...projected],
        personas: [],
        channels: [],
        ...(pendingFleetSources.size || unansweredFleetSources.size
          ? {
              readWarnings: [
                {
                  source: "native_fleet_projection",
                  reason: "unavailable" as const,
                  message: "A fleet source did not answer.",
                },
              ],
            }
          : {}),
      },
      waitingRosterSeats(),
    );
    return projected;
  }

  return {
    FLEET_READ_TIMEOUT_MS,
    ROSTER_READ_TIMEOUT_MS,
    FLEET_EFFICIENCY_DEADLINE_MS,
    pendingFleetSources,
    unansweredFleetSources,
    refreshFleet,
    observeSharedFleet,
    enrichCheckoutSeats,
    get lastProjectedSeats() {
      return lastProjectedSeats;
    },
    get fleetRefresh() {
      return fleetRefresh;
    },
  };
}
