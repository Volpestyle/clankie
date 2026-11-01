import {
  type OperatorConversationServiceResult,
  type OperatorFleetSeat,
  type OperatorFleetSnapshot,
} from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { type CaptainOptions } from "./captain-types.ts";
import { createWorkerReports } from "./captain-worker-reports.ts";
import { createFleetProjection } from "./captain-fleet-projection.ts";
import { ConversationStore } from "./conversations.ts";
import {
  deriveFleetEdges,
  PromptEdgeWindow,
  SeatMessageWindow,
  LeadVisitWindow,
  type EdgeSeat,
} from "./fleet-edges.ts";
import { FleetChangeClock } from "./herdr-fleet-changes.ts";
import { HerdrWatchStore } from "./herdr-watch.ts";
import { fleetRosterWork } from "./fleet-roster-work.ts";
import { FleetRoster } from "./fleet-roster.ts";
import type { FleetRosterStarter } from "@clankie/protocol/fleet-roster";
import { PaneTidy } from "./pane-tidy.ts";
import { PersonaStore } from "./personas.ts";
import { type SeatLedger } from "./seat-ledger.ts";
import type { CreateOperatorServiceContext } from "./captain-operator-service.ts";

export interface FleetRosterContext {
  readonly options: CaptainOptions;
  readonly fleetProjection: ReturnType<typeof createFleetProjection>;
  readonly pendingFleetSources: Set<string>;
  readonly unansweredFleetSources: Set<string>;
  readonly ROSTER_READ_TIMEOUT_MS: number;
  readonly FLEET_READ_TIMEOUT_MS: number;
  readonly refreshFleet: ReturnType<typeof createFleetProjection>["refreshFleet"];
  readonly enrichCheckoutSeats: ReturnType<typeof createFleetProjection>["enrichCheckoutSeats"];
  readonly settingsStore: SettingsStore;
  readonly fleetRoster: FleetRoster;
  readonly waitingRosterSeats: () => Set<string>;
  readonly conversations: ConversationStore;
  readonly personas: PersonaStore;
  readonly herdrWatches: HerdrWatchStore;
  readonly fleetChanges: FleetChangeClock;
  readonly conversationGoal: CreateOperatorServiceContext["conversationGoal"];
  readonly conversationAssignment: CreateOperatorServiceContext["conversationAssignment"];
  readonly paneTidy: PaneTidy;
  readonly leadVisits: LeadVisitWindow;
  readonly seatLedger: SeatLedger;
  readonly promptEdges: PromptEdgeWindow;
  readonly seatMessages: SeatMessageWindow;
  /** Read at call time: replaced as the fleet is read, set by the HTTP app, or built later (ADR 0325). */
  readonly liveEdgeSeats: readonly EdgeSeat[];
  readonly deviceName: ((deviceId: string) => string | undefined) | undefined;
  readonly reportSummaries: ReturnType<typeof createWorkerReports>["reportSummaries"];
}

/**
 * The fleet roster: bounded display reads, roster seats, the operator's fleet
 * roster and snapshot, and who started each agent (moved from the captain, ADR 0325).
 */
export function createFleetRoster(ctx: FleetRosterContext) {
  const {
    options,
    fleetProjection,
    pendingFleetSources,
    unansweredFleetSources,
    ROSTER_READ_TIMEOUT_MS,
    FLEET_READ_TIMEOUT_MS,
    refreshFleet,
    enrichCheckoutSeats,
    settingsStore,
    fleetRoster,
    waitingRosterSeats,
    conversations,
    personas,
    herdrWatches,
    fleetChanges,
    conversationGoal,
    conversationAssignment,
    paneTidy,
    leadVisits,
    seatLedger,
    promptEdges,
    seatMessages,
  } = ctx;

  /**
   * One display read's deadline. A read that misses it names the pending
   * component; the caller falls back to the last completed observation.
   */
  function boundedFleetRead(timeoutMs: number) {
    const deadline = performance.now() + timeoutMs;
    const readWarnings: import("@clankie/protocol").OperatorFleetReadWarnings = [];
    async function bounded<T>(source: string, read: Promise<T>): Promise<{ value: T } | undefined> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          read.then((value) => ({ value })),
          new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), Math.max(0, deadline - performance.now()));
          }),
        ]);
        if (result === undefined) {
          const sources =
            source === "native_fleet_projection" && pendingFleetSources.size
              ? [...pendingFleetSources].slice(0, 16)
              : [source];
          for (const pending of sources.slice(0, 16 - readWarnings.length))
            readWarnings.push({
              source: pending,
              reason: "timeout",
              message: `${pending} did not finish within ${timeoutMs} ms; this response contains the last available observation, not confirmed live seats.`,
            });
        }
        return result;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    return { deadline, readWarnings, bounded };
  }

  /**
   * The roster answers inside its callers' five-second client deadline. A
   * projection still running keeps going for the next read; this one returns
   * the last completed projection and says so, never live authority.
   */
  async function rosterSeats({ includeCheckouts = false }: { includeCheckouts?: boolean } = {}): Promise<{
    seats: readonly OperatorFleetSeat[];
    readWarnings?: import("@clankie/protocol").OperatorFleetReadWarnings;
  }> {
    const { readWarnings, bounded } = boundedFleetRead(ROSTER_READ_TIMEOUT_MS);
    const observed = await bounded("native_fleet_projection", refreshFleet());
    const basicSeats = observed?.value ?? fleetProjection.lastProjectedSeats;
    const checkout =
      includeCheckouts && observed !== undefined
        ? await bounded("checkout_observations", enrichCheckoutSeats(basicSeats))
        : undefined;
    return {
      seats: checkout?.value ?? basicSeats,
      ...(readWarnings.length === 0 ? {} : { readWarnings }),
    };
  }

  /** Prefer a stable cursor, but a busy or slow fleet must not starve display reads. */
  async function readFleetRoster({
    includeWork = false,
    includeStarters = false,
  }: {
    includeWork?: boolean;
    includeStarters?: boolean;
  } = {}) {
    const started = Date.now();
    const { snapshot } = await fleetSnapshot();
    const readWarnings = [...(snapshot.readWarnings ?? [])];
    for (const source of [...unansweredFleetSources, ...pendingFleetSources]) {
      if (readWarnings.length >= 16 || readWarnings.some((warning) => warning.source === source)) continue;
      readWarnings.push({
        source,
        reason: "unavailable",
        message: `${source} has not answered; its agents are not confirmed absent.`,
      });
    }
    const work = includeWork
      ? await (async () => {
          const settings = await settingsStore.loadFenced();
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), Math.max(1, 4_000 - (Date.now() - started)));
          try {
            const work = await fleetRosterWork(
              snapshot,
              settings.settings.projects,
              options.fleetProjectMembership?.(),
              controller.signal,
            );
            try {
              settings.assertCurrent();
            } catch {
              for (const row of work.values()) row.project = null;
            }
            return work;
          } finally {
            clearTimeout(timer);
          }
        })()
      : undefined;
    const result = fleetRoster.project(
      { ...snapshot, ...(readWarnings.length ? { readWarnings } : {}) },
      waitingRosterSeats(),
    );
    const starters = includeStarters ? seatStarters(snapshot) : undefined;
    return {
      ...result,
      agents: result.agents.map((agent) => {
        const lead = agent.leadId && conversations.conversation(agent.leadId)?.title;
        return {
          ...agent,
          ...(lead ? { lead } : {}),
          ...work?.get(agent.seatId),
          ...(starters === undefined
            ? {}
            : { startedBy: starters(agent.seatId, agent.occupantId, agent.machineId) }),
        };
      }),
      leads: result.leads.map((lead) => ({
        ...lead,
        name: conversations.conversation(lead.id)?.title ?? lead.name,
      })),
    };
  }

  /**
   * Who started each agent (ADR 0321): display only, and no starter outranks another.
   * Adoption sets the current lead, never who started it.
   */
  function seatStarters(
    snapshot: OperatorFleetSnapshot,
  ): (seatId: string, occupantId: string, machineId: string) => FleetRosterStarter {
    const names = new Map(snapshot.personas.map((persona) => [persona.personaId, persona.name]));
    const machineOf = (seat: OperatorFleetSeat) => seat.fleet ?? "local";
    return (seatId, occupantId, machineId) => {
      const seat = snapshot.seats.find(
        (entry) =>
          entry.seatId === seatId && entry.occupantId === occupantId && machineOf(entry) === machineId,
      );
      if (seat?.owner?.hired === true) {
        const asked = herdrWatches.seatStarter(seatId, occupantId);
        if (asked?.kind === "app")
          return { kind: "app", name: ctx.deviceName?.(asked.deviceId) ?? "A connected app" };
        return asked?.kind === "owner" ? { kind: "owner" } : { kind: "clankie" };
      }
      const parent =
        seat?.parentSeatId === undefined
          ? undefined
          : snapshot.seats.find(
              (entry) => entry.seatId === seat.parentSeatId && machineOf(entry) === machineId,
            );
      const parentName = parent && (names.get(parent.personaId) ?? parent.title).trim();
      // Not hired and not spawned by another agent: someone started it by hand on the owner's machine.
      return parentName ? { kind: "agent", name: parentName.slice(0, 256) } : { kind: "owner" };
    };
  }

  async function fleetSnapshot({ includeCheckouts = false }: { includeCheckouts?: boolean } = {}): Promise<
    Extract<OperatorConversationServiceResult, { op: "fleet" }>
  > {
    const { deadline, readWarnings, bounded } = boundedFleetRead(FLEET_READ_TIMEOUT_MS);
    // Only one shared refresh can remain in flight after a display deadline.
    // It retains its native transport deadlines and is never cancelled/reused
    // as the fresh census that authorizes a mutation.
    for (let attempt = 0; ; attempt++) {
      const cursor = fleetChanges.current();
      const observed = await bounded("native_fleet_projection", refreshFleet());
      const basicSeats = observed?.value ?? fleetProjection.lastProjectedSeats;
      const checkout =
        includeCheckouts && observed !== undefined
          ? await bounded("checkout_observations", enrichCheckoutSeats(basicSeats))
          : undefined;
      const seats = checkout?.value ?? basicSeats;
      const channelsResult = await conversations.serve({ op: "channels", schemaVersion: 1 });
      const goalConversations = await conversations.serve({ op: "list", schemaVersion: 1 });
      const goals =
        goalConversations.op === "list"
          ? goalConversations.conversations.flatMap((conversation) => {
              const goal = conversationGoal(conversation.conversationId);
              return goal === undefined ? [] : [{ conversationId: conversation.conversationId, goal }];
            })
          : [];
      const assignments =
        goalConversations.op === "list"
          ? goalConversations.conversations.flatMap((conversation) => {
              const assignment = conversationAssignment(conversation.conversationId);
              return assignment === undefined
                ? []
                : [{ conversationId: conversation.conversationId, assignment }];
            })
          : [];
      if (channelsResult.op !== "channels") throw new Error("Fleet channel read returned the wrong result");
      if (cursor !== fleetChanges.current() && readWarnings.length === 0) {
        if (attempt === 0 && performance.now() < deadline) continue;
        readWarnings.push({
          source: "fleet_consistency",
          reason: "changed_during_read",
          message:
            "Fleet activity changed during this read; these contacts and seats are a partial view. Read again for current state.",
        });
      }
      const fleetPersonas = [
        ...personas.projection(seats, (personaId) => conversations.conversationForPersona(personaId)),
      ];
      return {
        op: "fleet",
        schemaVersion: 1,
        snapshot: {
          schemaVersion: 1,
          cursor,
          ...(readWarnings.length === 0 ? {} : { readWarnings }),
          goals,
          assignments,
          closedPanes: [...paneTidy.history()],
          leadVisits: [...leadVisits.recent()],
          seats: [...seats],
          workerReports: ctx.reportSummaries(),
          personas: fleetPersonas,
          channels: [...channelsResult.channels],
          roomHandoffs: conversations.roomHandoffs(),
          // Bounded by the roster it is read against, so the day's counts can
          // never outnumber the seats the snapshot carries.
          tallies: [...seatLedger.tallies(seats.map((seat) => seat.seatId))],
          edges: [...deriveFleetEdges(ctx.liveEdgeSeats, promptEdges.recent(), seatMessages.recent())],
          ...(options.fleetResources?.status() === undefined
            ? {}
            : { resources: options.fleetResources.status() }),
        },
      };
    }
  }

  return { boundedFleetRead, rosterSeats, readFleetRoster, seatStarters, fleetSnapshot };
}
