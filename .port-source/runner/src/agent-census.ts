import { createLogger } from "@clankie/observability";
import {
  AGENT_CENSUS_MAX_ENTRIES,
  AdoptWorkerCommandSchema,
  AgentCensusSchema,
  DirectAdoptedWorkerCommandSchema,
  ReleaseWorkerAdoptionCommandSchema,
  type AdoptWorkerResult,
  type AdoptedWorkerBinding,
  type DirectAdoptedWorkerResult,
  type AgentCensus,
  type AgentCensusEntry,
  type AgentObservation,
  type WorkerAdoption,
} from "@clankie/protocol";
import type { ProcessLease } from "./process-leases.ts";
import type { ReconcileAdoptionsReport, WorkerAdoptionStore } from "./worker-adoptions.ts";

const logger = createLogger({ service: "clankie-runner-agent-census", version: "0.1.0" });

/** What the loopback plane calls into. Owned here, where it is implemented (ADR 0078). */
export interface AgentCensusPort {
  census(): Promise<AgentCensus>;
  adopt(request: unknown): Promise<unknown>;
  release(request: unknown): Promise<void>;
  direct(request: unknown): Promise<unknown>;
}

export interface TakeAgentCensusInput {
  runnerId: string;
  /** What the transport can currently see, or `undefined` when it cannot be asked. */
  observations: readonly AgentObservation[] | undefined;
  /** Process leases this runner owns, used to recognize its own workers. */
  leases: readonly ProcessLease[];
  adoptions: WorkerAdoptionStore;
  clock?: () => Date;
}

/**
 * Classify every agent the transport can see (ADR 0078).
 *
 * The census reports; it never adopts. An `unclaimed` entry is an offer, and
 * leaving it unclaimed is a valid outcome — auto-adoption would make the runner
 * the owner of every stray terminal on the machine.
 *
 * `transportAvailable: false` is a distinct state from an empty census on
 * purpose. "I cannot see" and "nothing is there" are different answers, and
 * collapsing them would let a dead socket read as a quiet machine — the class
 * of false statement ADR 0072 rules against.
 */
export async function takeAgentCensus(input: TakeAgentCensusInput): Promise<AgentCensus> {
  const clock = input.clock ?? (() => new Date());
  const takenAt = clock().toISOString();
  if (input.observations === undefined) {
    return AgentCensusSchema.parse({
      schemaVersion: 1,
      runnerId: input.runnerId,
      takenAt,
      transportAvailable: false,
      entries: [],
      counts: { owned: 0, adopted: 0, lapsed: 0, unclaimed: 0 },
      truncated: 0,
    });
  }

  const adoptions = await input.adoptions.list();
  const adoptionByTerminal = indexAdoptionsByTerminal(adoptions);
  const ownedWorkerRunIds = new Map<string, ProcessLease>();
  for (const lease of input.leases) {
    if (lease.state === "live" || lease.state === "cancelling") {
      ownedWorkerRunIds.set(lease.workerRunId, lease);
    }
  }

  // Deterministic order so a census taken twice from the same state is
  // byte-identical; transports make no ordering promise.
  const sorted = [...input.observations].sort((left, right) =>
    terminalKey(left.transport, left.transportInstanceId, left.terminalId).localeCompare(
      terminalKey(right.transport, right.transportInstanceId, right.terminalId),
    ),
  );
  const entries: AgentCensusEntry[] = [];
  const observedKeys = new Set<string>();
  for (const observation of sorted) {
    observedKeys.add(
      terminalKey(observation.transport, observation.transportInstanceId, observation.terminalId),
    );
    const declaration = await input.adoptions.readDeclaration(observation);
    const digest = {
      runnerObserved: observation,
      ...(declaration ? { selfDeclared: declaration } : {}),
    };
    entries.push(classify(observation, digest, adoptionByTerminal, ownedWorkerRunIds));
  }

  // A terminal-gone lapse has no current observation to iterate. Keep the
  // durable binding visible until an operator releases it instead of letting a
  // broken adoption disappear from the census that is meant to expose it.
  for (const adoption of adoptions) {
    if (adoption.state !== "lapsed" || adoption.lapseReason === undefined) continue;
    const key = terminalKey(
      adoption.binding.transport,
      adoption.binding.transportInstanceId,
      adoption.binding.terminalId,
    );
    if (observedKeys.has(key)) continue;
    entries.push({
      classification: "lapsed",
      digest: { adoptionBinding: adoption.binding },
      workerRunId: adoption.workerRunId,
      adoptionId: adoption.adoptionId,
      grade: adoption.grade,
      lapseReason: adoption.lapseReason,
    });
  }
  const truncated = Math.max(0, entries.length - AGENT_CENSUS_MAX_ENTRIES);
  const visible = entries.slice(0, AGENT_CENSUS_MAX_ENTRIES);

  return AgentCensusSchema.parse({
    schemaVersion: 1,
    runnerId: input.runnerId,
    takenAt,
    transportAvailable: true,
    entries: visible,
    counts: {
      owned: countOf(visible, "owned"),
      adopted: countOf(visible, "adopted"),
      lapsed: countOf(visible, "lapsed"),
      unclaimed: countOf(visible, "unclaimed"),
    },
    truncated,
  });
}

export interface AgentCensusServiceOptions {
  runnerId: string;
  adoptions: WorkerAdoptionStore;
  /** Live transport listing, or `undefined` when the transport cannot be asked. */
  observe: () => Promise<readonly AgentObservation[] | undefined>;
  /** Process leases this runner owns. */
  leases: () => Promise<readonly ProcessLease[]>;
  /** Bounded operator-parity delivery into a hosted agent, if the transport can. */
  deliver?: (binding: AdoptedWorkerBinding, text: string) => Promise<"delivered" | "terminal_gone">;
  clock?: () => Date;
}

/**
 * Binds the transport, the adoption store, and this runner's own leases into
 * the one surface the control plane talks to (ADR 0078).
 *
 * The control plane authenticates the operator and mints the directed-approval
 * receipt. The runner validates that receipt's closed shape and enforces facts
 * only it can see: exact transport instance, workspace, native agent session,
 * ownership, and grade/scope consistency.
 */
export class AgentCensusService implements AgentCensusPort {
  private readonly options: AgentCensusServiceOptions;

  public constructor(options: AgentCensusServiceOptions) {
    this.options = options;
  }

  public async census(): Promise<AgentCensus> {
    const observations = await this.options.observe();
    await this.options.adoptions.reconcile(observations);
    return takeAgentCensus({
      runnerId: this.options.runnerId,
      observations,
      leases: await this.options.leases(),
      adoptions: this.options.adoptions,
      ...(this.options.clock ? { clock: this.options.clock } : {}),
    });
  }

  public async adopt(request: unknown): Promise<AdoptWorkerResult> {
    const parsed = AdoptWorkerCommandSchema.safeParse(request);
    if (!parsed.success) return { outcome: "refused", reason: "not_found" };
    const observations = await this.options.observe();
    if (observations === undefined) return { outcome: "refused", reason: "transport_unavailable" };
    const observation = observations.find(
      (candidate) =>
        candidate.transport === parsed.data.transport &&
        candidate.transportInstanceId === parsed.data.transportInstanceId &&
        candidate.terminalId === parsed.data.terminalId,
    );
    return this.options.adoptions.adopt(parsed.data, observation, await this.ownedSessionIds());
  }

  public async release(request: unknown): Promise<void> {
    const parsed = ReleaseWorkerAdoptionCommandSchema.safeParse(request);
    if (!parsed.success) return;
    await this.options.adoptions.release(parsed.data.adoptionId, parsed.data.releasedBy);
  }

  /**
   * Deliver bounded direction into an adopted agent (ADR 0078).
   *
   * The binding is re-verified against the live transport immediately before
   * delivery, not merely at startup. An adoption reconciled an hour ago proves
   * nothing about the agent occupying that terminal now, and steering text sent
   * into the wrong session is the one failure this whole seam exists to avoid.
   */
  public async direct(request: unknown): Promise<DirectAdoptedWorkerResult> {
    const parsed = DirectAdoptedWorkerCommandSchema.safeParse(request);
    if (!parsed.success) return { outcome: "refused", reason: "unknown_adoption" };
    const deliver = this.options.deliver;
    if (!deliver) return { outcome: "refused", reason: "transport_unavailable" };

    const adoption = (await this.options.adoptions.list()).find(
      (record) => record.adoptionId === parsed.data.adoptionId,
    );
    if (!adoption) return { outcome: "refused", reason: "unknown_adoption" };
    if (adoption.state !== "active") return { outcome: "refused", reason: "not_active" };
    // Operator parity is configuration and steering; an observed adoption grants
    // neither, so it can be read about but never talked to.
    if (adoption.grade !== "directed") return { outcome: "refused", reason: "not_directed" };

    const observations = await this.options.observe();
    if (observations === undefined) return { outcome: "refused", reason: "transport_unavailable" };
    const observation = observations.find(
      (candidate) =>
        candidate.transport === adoption.binding.transport &&
        candidate.transportInstanceId === adoption.binding.transportInstanceId &&
        candidate.terminalId === adoption.binding.terminalId,
    );
    if (!observation || !matchesAdoptedBinding(observation, adoption.binding)) {
      await this.options.adoptions.reconcile(observations);
      return { outcome: "refused", reason: "binding_lapsed" };
    }

    const delivery = await deliver(adoption.binding, parsed.data.text);
    if (delivery === "terminal_gone") {
      await this.options.adoptions.reconcile(await this.options.observe());
      return { outcome: "refused", reason: "binding_lapsed" };
    }
    await this.options.adoptions.recordDirection(adoption, parsed.data.directedBy, parsed.data.text.length);
    return {
      outcome: "delivered",
      adoptionId: adoption.adoptionId,
      workerRunId: adoption.workerRunId,
    };
  }

  /**
   * Startup pass: re-verify every active binding, then take and log the census.
   * A failure here never blocks the runner — an unknown fleet is a degraded
   * state to report, not a reason to refuse to start.
   */
  public async reconcileAtStartup(): Promise<{
    report: ReconcileAdoptionsReport;
    census: AgentCensus;
  }> {
    const observations = await this.options.observe();
    const report = await this.options.adoptions.reconcile(observations);
    const census = await takeAgentCensus({
      runnerId: this.options.runnerId,
      observations,
      leases: await this.options.leases(),
      adoptions: this.options.adoptions,
      ...(this.options.clock ? { clock: this.options.clock } : {}),
    });
    logger.info(
      {
        transportAvailable: census.transportAvailable,
        ...census.counts,
        truncated: census.truncated,
        lapsed: report.lapsed.length,
      },
      "startup agent census taken",
    );
    return { report, census };
  }

  private async ownedSessionIds(): Promise<ReadonlySet<string>> {
    const leases = await this.options.leases();
    return new Set(
      leases
        .filter((lease) => lease.state === "live" || lease.state === "cancelling")
        .map((lease) => lease.workerRunId),
    );
  }
}

function classify(
  observation: AgentObservation,
  digest: AgentCensusEntry["digest"],
  adoptionByTerminal: ReadonlyMap<string, WorkerAdoption>,
  ownedWorkerRunIds: ReadonlyMap<string, ProcessLease>,
): AgentCensusEntry {
  // A worker this runner spawned carries its own workerRunId as the transport's
  // agent session id, so ownership is a lookup rather than a guess.
  const owned =
    observation.agentSessionId === undefined ? undefined : ownedWorkerRunIds.get(observation.agentSessionId);
  if (owned) {
    return {
      classification: "owned",
      digest,
      workerRunId: owned.workerRunId,
      missionId: owned.missionId,
      taskId: owned.taskId,
    };
  }

  const adoption = adoptionByTerminal.get(
    terminalKey(observation.transport, observation.transportInstanceId, observation.terminalId),
  );
  if (adoption?.state === "active" && matchesAdoptedBinding(observation, adoption.binding)) {
    return {
      classification: "adopted",
      digest,
      workerRunId: adoption.workerRunId,
      adoptionId: adoption.adoptionId,
      grade: adoption.grade,
    };
  }
  if (adoption?.state === "lapsed" && adoption.lapseReason !== undefined) {
    return {
      classification: "lapsed",
      digest,
      workerRunId: adoption.workerRunId,
      adoptionId: adoption.adoptionId,
      grade: adoption.grade,
      lapseReason: adoption.lapseReason,
    };
  }
  return { classification: "unclaimed", digest };
}

function indexAdoptionsByTerminal(adoptions: readonly WorkerAdoption[]): Map<string, WorkerAdoption> {
  const index = new Map<string, WorkerAdoption>();
  for (const adoption of adoptions) {
    if (adoption.state === "released") continue;
    const key = terminalKey(
      adoption.binding.transport,
      adoption.binding.transportInstanceId,
      adoption.binding.terminalId,
    );
    const existing = index.get(key);
    // Prefer the active record when a terminal carries both an active and a
    // lapsed history, so a re-adopted agent is not reported by its old failure.
    if (!existing || (existing.state !== "active" && adoption.state === "active")) {
      index.set(key, adoption);
    }
  }
  return index;
}

function countOf(
  entries: readonly AgentCensusEntry[],
  classification: AgentCensusEntry["classification"],
): number {
  return entries.filter((entry) => entry.classification === classification).length;
}

function matchesAdoptedBinding(observation: AgentObservation, binding: AdoptedWorkerBinding): boolean {
  return (
    observation.adoptable &&
    observation.transport === binding.transport &&
    observation.transportInstanceId === binding.transportInstanceId &&
    observation.terminalId === binding.terminalId &&
    observation.harness === binding.harness &&
    observation.agentSessionId === binding.agentSessionId &&
    observation.workspace.workspaceId === binding.workspace.workspaceId &&
    observation.workspace.root === binding.workspace.root
  );
}

function terminalKey(transport: string, transportInstanceId: string, terminalId: string): string {
  return `${transport}:${transportInstanceId}:${terminalId}`;
}
