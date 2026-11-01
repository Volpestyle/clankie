import { join } from "node:path";
import type { FleetRoomParty, OperatorFleetSeat } from "@clankie/protocol";
import type { ProjectVelocity } from "@clankie/protocol/auto-rounds";
import { readableLinkedRepos, type ClankieSettings } from "@clankie/settings";
import type { WatchGate } from "../watch.ts";
import { accountCapacityLines } from "./account-allocation.ts";
import type { DriftCorrectionInput } from "./auto-correction-tools.ts";
import { AutoRoundCadence } from "./auto-cadence.ts";
import { driftSection, driftSignals, withDrift } from "./auto-drift.ts";
import {
  autoProjectRounds,
  autoRoundDue,
  autoRoundFingerprint,
  autoRoundPrompt,
  type AutoProjectState,
} from "./auto-projects.ts";
import { milestoneSignals, reportingSection } from "./auto-reporting.ts";
import { AutoRoundRecord } from "./auto-rounds.ts";
import {
  autoPlanCapacity,
  autoStaffingSeats,
  projectStaffing,
  projectStaffingSeats,
  staffingSection,
  staffingSignals,
  staffingTotals,
} from "./auto-staffing.ts";
import { measureVelocityWithin, velocityLine, type VelocityDeps } from "./auto-velocity.ts";
import type { AutonomyStore } from "./autonomy.ts";
import type { createDiscordTurns } from "./captain-discord-turns.ts";
import type { CaptainOptions } from "./captain-types.ts";
import { assertConversationAuthority, type ConversationAuthority } from "./conversation-owner.ts";
import type { ConversationStore } from "./conversations.ts";
import type { FleetRoomRecord } from "./fleet-room.ts";
import type { createWorkerAccountsReader } from "./harness-accounts.ts";
import type { LeadChat } from "./lead-roster.ts";
import { ProjectMirrors } from "./project-mirrors.ts";
import { readRepositoryChurn } from "./repository-churn.ts";

export interface AutoRoundsContext {
  readonly options: Pick<
    CaptainOptions,
    | "stateDir"
    | "remoteOrigin"
    | "projectOutcomes"
    | "autoRoundIntervalMs"
    | "fleetRoundIntervalMs"
    | "projectWorkQueue"
    | "autoIdleRewakeMs"
  >;
  readonly settings: () => Promise<ClankieSettings>;
  readonly shutdown: AbortController;
  readonly autonomy: AutonomyStore;
  readonly watch: WatchGate;
  readonly conversations: ConversationStore;
  /** Sources whose latest census failed or is still pending; the captain mutates them in place. */
  readonly unansweredFleetSources: ReadonlySet<string>;
  readonly pendingFleetSources: ReadonlySet<string>;
  /** Read at call time: the captain reassigns its named local fleets (ADR 0325). */
  readonly namedLocal: ReadonlyArray<{ id: string }>;
  readonly refreshFleet: () => Promise<readonly OperatorFleetSeat[]>;
  readonly leadChats: () => Promise<readonly LeadChat[]>;
  readonly readWorkerAccounts: ReturnType<typeof createWorkerAccountsReader>;
  readonly wakeConversation: ReturnType<typeof createDiscordTurns>["wakeConversation"];
  readonly noteFleetRoom: (record: FleetRoomRecord) => void;
  readonly leadParty: (conversationId: string) => FleetRoomParty;
}

/** Projects on Auto (ADR 0264): measured every tick, each round woken in its lead's conversation. */
export function createAutoRounds(ctx: AutoRoundsContext) {
  const {
    options,
    settings,
    shutdown,
    autonomy,
    watch,
    conversations,
    unansweredFleetSources,
    pendingFleetSources,
    refreshFleet,
    leadChats,
    readWorkerAccounts,
    wakeConversation,
    noteFleetRoom,
    leadParty,
  } = ctx;
  // Projects on Auto (ADR 0264): each configured project lead hears its own
  // projects; projects without an unambiguous lead go to the global head.
  const pendingAutoRounds = new Set<string>();
  const projectMirrors = new ProjectMirrors(join(options.stateDir, "project-mirrors"), async (workspace) => {
    if (!options.remoteOrigin) throw new Error("no remote command channel");
    return await options.remoteOrigin(workspace);
  });
  const autoRoundRecord = new AutoRoundRecord(join(options.stateDir, "auto-rounds"));
  const velocityDeps: VelocityDeps = {
    outcomes:
      options.projectOutcomes ??
      (async () => ({ state: "unavailable" as const, reason: "no tracker outcome reader in this service" })),
    history: (project) => projectMirrors.history(project),
    linkedRepos: async (project) =>
      readableLinkedRepos((await settings()).projects, project)
        .filter((repo) => repo.machineId === "local")
        .map((repo) => repo.path),
    churn: readRepositoryChurn,
  };
  const settleAutoRound = (
    conversationId: string,
    roundId: string | undefined,
    delivered: boolean,
    reason?: string,
  ) => {
    if (roundId === undefined) return;
    try {
      autoRoundRecord.settled(roundId, delivered, reason);
    } catch (error) {
      console.warn("Auto round record unavailable", roundId, String(error));
    }
    try {
      autoCadence.settled(conversationId, roundId, delivered);
    } catch (error) {
      console.warn("Auto cadence settlement unavailable", roundId, String(error));
    }
  };
  const unavailableAutoMachines = () =>
    new Set(
      [...unansweredFleetSources, ...pendingFleetSources]
        .filter((source) => source.startsWith("herdr:"))
        .map((source) => {
          const fleet = source.slice(6);
          return fleet === "default" || ctx.namedLocal.some((entry) => entry.id === fleet) ? "local" : fleet;
        }),
    );
  const readAutoStaffingCensus = async () => {
    const seats = autoStaffingSeats(
      await refreshFleet(),
      ctx.namedLocal.map((fleet) => fleet.id),
    );
    return { seats, unavailableMachines: unavailableAutoMachines() };
  };
  const readAutoRounds = async (snapshot?: Awaited<ReturnType<typeof readAutoStaffingCensus>>) => {
    const current = await settings();
    const { seats, unavailableMachines } = snapshot ?? (await readAutoStaffingCensus());
    const workerCounts = new Map(
      current.projects.projects.map((project) => {
        const workers = projectStaffingSeats(project, seats);
        const unknown =
          [...project.workspaces, ...project.worktreeRoots].some((root) =>
            unavailableMachines.has(root.machineId),
          ) || workers.some((seat) => seat.status === "unknown");
        return [project.id, unknown ? null : workers.length] as const;
      }),
    );
    return autoProjectRounds(
      current.projects.projects,
      workerCounts,
      await leadChats(),
      conversations.defaultGlobalConversationId(),
    );
  };
  async function recordDriftCorrection(authority: ConversationAuthority, input: DriftCorrectionInput) {
    await assertConversationAuthority(authority);
    const rounds = await readAutoRounds();
    if (!rounds.get(authority.owner.conversationId)?.some((project) => project.id === input.projectId))
      throw new Error("Auto project is not owned by this lead conversation");
    await assertConversationAuthority(authority);
    shutdown.signal.throwIfAborted();
    return autoRoundRecord.recordCorrection(authority.owner.conversationId, input);
  }
  const autoRoundIntervalMs = options.autoRoundIntervalMs ?? options.fleetRoundIntervalMs ?? 30 * 60_000;
  const autoCadence = new AutoRoundCadence(join(options.stateDir, "auto-rounds"), autoRoundIntervalMs, () =>
    autoRoundRecord.read({ limit: Number.MAX_SAFE_INTEGER }),
  );
  /** Each Auto project's latest measurement; reused while younger than a tick (VUH-2284). */
  const autoMeasurements = new Map<string, ProjectVelocity>();
  const autoMeasurementPolicies = new Map<string, string>();
  const measureAutoProjects = async (projectIds: ReadonlySet<string>) => {
    for (const id of autoMeasurements.keys())
      if (!projectIds.has(id)) {
        autoMeasurements.delete(id);
        autoMeasurementPolicies.delete(id);
      }
    const projects = (await settings()).projects.projects;
    await Promise.all(
      projects
        .filter((project) => projectIds.has(project.id))
        .map(async (project) => {
          const last = autoMeasurements.get(project.id);
          // A little slack, so a tick's own jitter never skips a measurement.
          const policy = JSON.stringify(project);
          if (
            last &&
            autoMeasurementPolicies.get(project.id) === policy &&
            Date.now() - Date.parse(last.measuredAt) < autoRoundIntervalMs * 0.9
          )
            return;
          const correction = autoRoundRecord.pendingCorrection(project.id);
          const velocity = await measureVelocityWithin(project, autoRoundRecord.lastMilestone(project.id), {
            ...velocityDeps,
            ...(correction ? { correction } : {}),
          });
          // A stopped runtime must not append after its state directory is handed over.
          if (shutdown.signal.aborted) return;
          autoRoundRecord.observeUpdates(velocity);
          autoMeasurementPolicies.set(project.id, policy);
          autoMeasurements.set(
            project.id,
            autoRoundRecord.withReporting(withDrift(velocity, autoRoundRecord.pendingDrift(project.id))),
          );
        }),
    );
  };
  const autoFingerprint = (states: readonly AutoProjectState[]) =>
    autoRoundFingerprint(
      states,
      (id) => [
        ...driftSignals(autoMeasurements.get(id)),
        ...staffingSignals(autoMeasurements.get(id)?.staffing),
      ],
      (id) => milestoneSignals(autoMeasurements.get(id)),
    );
  const stopAutoRounds = autoCadence.start(async () => {
    if (shutdown.signal.aborted || !autonomy.enabled || (await watch.watching())) return;
    await projectMirrors
      .refresh((await settings()).projects.projects)
      .catch((error: unknown) => console.warn("Project mirrors unavailable", String(error)));
    const census = await readAutoStaffingCensus();
    const { seats } = census;
    const rounds = await readAutoRounds(census);
    if (shutdown.signal.aborted) return;
    autoCadence.retain(new Set(rounds.keys()));
    // Velocity and drift (ADR 0270): measured every tick, so new drift changes the fingerprint.
    await measureAutoProjects(new Set([...rounds.values()].flat().map((state) => state.id)));
    if (shutdown.signal.aborted) return;
    const autoProjects = (await settings()).projects.projects.filter((project) => project.auto);
    const machines = [
      ...new Set(
        autoProjects.flatMap((project) =>
          [...project.workspaces, ...project.worktreeRoots].map((root) => root.machineId),
        ),
      ),
    ];
    const reports = await Promise.all(
      machines.map(async (machine) => {
        try {
          return await readWorkerAccounts(machine === "local" ? undefined : machine, ["claude", "codex"]);
        } catch {
          return undefined;
        } // Missing observations stay unknown; never authorize a hire.
      }),
    );
    const plans = autoPlanCapacity(reports.flatMap((report) => (report ? [report] : [])));
    await Promise.all(
      autoProjects.map(async (project) => {
        const velocity = autoMeasurements.get(project.id);
        if (!velocity) return;
        let queue: import("@clankie/protocol/auto-rounds").AutoWorkQueue;
        try {
          queue = (await options.projectWorkQueue?.(project)) ?? {
            state: "unknown",
            reason: "No tracker queue reader in this service",
          };
        } catch (error) {
          queue = { state: "unknown", reason: error instanceof Error ? error.message : String(error) };
        }
        if (shutdown.signal.aborted) return;
        const previous = autoRoundRecord.read({ projectId: project.id, limit: 1 })[0];
        autoMeasurements.set(project.id, {
          ...velocity,
          staffing: projectStaffing({
            project,
            queue,
            seats,
            plans,
            started: velocity.started,
            unavailableMachines: census.unavailableMachines,
            ...(previous ? { previous } : {}),
          }),
        });
      }),
    );
    if (shutdown.signal.aborted) return;
    for (const [conversationId, states] of rounds) {
      if (pendingAutoRounds.has(conversationId)) continue;
      const fingerprint = autoFingerprint(states);
      if (!autoRoundDue(fingerprint, autoCadence.last(conversationId), Date.now(), options.autoIdleRewakeMs))
        continue;
      pendingAutoRounds.add(conversationId);
      let roundId: string | undefined;
      let passedDeliveryGuard = false;
      let roundSummary: string | undefined;
      void (async () => {
        const velocities = states.flatMap((state) => {
          const velocity = autoMeasurements.get(state.id);
          return velocity === undefined ? [] : [autoRoundRecord.withReporting(velocity)];
        });
        const groupProjects = autoProjects.filter((project) =>
          states.some((state) => state.id === project.id),
        );
        const groupMachines = new Set(
          groupProjects.flatMap((project) =>
            [...project.workspaces, ...project.worktreeRoots].map((root) => root.machineId),
          ),
        );
        try {
          roundId = autoRoundRecord.measured(
            conversationId,
            velocities,
            new Date(),
            staffingTotals(
              velocities,
              plans.filter((plan) => groupMachines.has(plan.machine)),
              { seats, projects: groupProjects },
            ),
          );
          autoCadence.claim(conversationId, roundId, fingerprint);
          roundSummary = velocities.map(velocityLine).join("\n");
        } catch (error) {
          console.warn("Auto round record unavailable", conversationId, String(error));
          // A milestone request must be durably claimed before it can be dispatched.
          throw error;
        }
        const capacity = reports.flatMap((report) =>
          report && groupMachines.has(report.machine) ? accountCapacityLines(report) : [],
        );
        return wakeConversation(
          { conversationId },
          autoRoundPrompt(states, velocities.map(velocityLine), driftSection(velocities, roundId), capacity, [
            ...reportingSection(velocities),
            ...staffingSection(velocities),
          ]),
          async () => {
            if (shutdown.signal.aborted || !autonomy.enabled) throw new Error("Auto is paused");
            const current = (await readAutoRounds()).get(conversationId);
            if (shutdown.signal.aborted || !autonomy.enabled) throw new Error("Auto is paused");
            if (!current || autoFingerprint(current) !== fingerprint)
              throw new Error("Projects on Auto changed before delivery");
            passedDeliveryGuard = true;
          },
          "machine",
          true,
          false,
        );
      })()
        .then((accepted) => {
          settleAutoRound(conversationId, roundId, accepted, accepted ? undefined : "not delivered");
          if (accepted && roundId !== undefined && roundSummary)
            noteFleetRoom({
              id: `auto-round:${roundId}`,
              at: new Date().toISOString(),
              kind: "auto_round",
              from: { kind: "clankie", label: "Clankie · Auto" },
              to: leadParty(conversationId),
              text: roundSummary,
              thread: { conversationId },
              // Admitted to the lead's conversation as a machine turn, not read by it.
              delivery: { stage: "stored" },
            });
          if (!accepted) console.warn("Auto round was not delivered", conversationId);
        })
        .catch((error: unknown) => {
          // Once dispatch could have begun, an exception proves no refusal. Keep the
          // journal claim unsettled across restart instead of asking for a second post.
          if (!passedDeliveryGuard) {
            settleAutoRound(conversationId, roundId, false, String(error));
          }
          if (!shutdown.signal.aborted) console.warn("Auto round unavailable", conversationId, String(error));
        })
        .finally(() => pendingAutoRounds.delete(conversationId));
    }
  });
  return { projectMirrors, velocityDeps, recordDriftCorrection, stopAutoRounds };
}
