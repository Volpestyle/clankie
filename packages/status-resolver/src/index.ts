import {
  CaptainPresenceEventSchema,
  WorkerStatusProvenanceSchema,
  WorkerStatusStateSchema,
  type DomainEvent,
  type WorkerStatusState,
} from "@clankie/protocol";

export const STATUS_SIGNAL_EVENT_TYPE = "worker.status.signal";
export const STATUS_RESOLVED_EVENT_TYPE = "worker.status.resolved";

export type AgentStatusTier = 0 | 1 | 2;

export type AgentStatusBasis =
  | "external_signal"
  | "heuristic"
  | "turn_started"
  | "turn_settled"
  | "waiting_user"
  | "waiting_dependency"
  | "captain_presence"
  | "captain_offline"
  | "worker_active"
  | "worker_settled"
  | "worker_failed"
  | "worker_offline";

export interface AgentStatusDegradation {
  code: string;
  error: string;
  consecutiveFailures: number;
  retryAt?: string;
}

export interface AgentStatusSourceProvenance {
  kind: "herdr_pane";
  workspaceId: string;
  paneId: string;
  agent?: string;
}

export interface AgentStatusSignal {
  state: WorkerStatusState;
  tier: AgentStatusTier;
  source: string;
  confidence: number;
  observedAt: string;
  basis: AgentStatusBasis;
  questionSummary?: string;
  degradation?: AgentStatusDegradation;
  provenance?: AgentStatusSourceProvenance;
}

export type AgentStatusSignalInput = Omit<AgentStatusSignal, "basis"> & {
  basis?: AgentStatusBasis;
};

export type StatusSignalDisposition =
  | "winner"
  | "attention_only"
  | "invalidated"
  | "superseded"
  | "unknown_filled";

export interface StatusSignalTrace extends AgentStatusSignal {
  sequence: number;
  disposition: StatusSignalDisposition;
  eventId?: string;
  eventType?: string;
}

export interface ResolvedAgentStatus {
  subjectId: string;
  state: WorkerStatusState;
  basis: AgentStatusBasis;
  tier: AgentStatusTier;
  source: string;
  confidence: number;
  observedAt: string;
  provenance?: AgentStatusSourceProvenance;
  winner: StatusSignalTrace;
  signalChain: StatusSignalTrace[];
  attention: StatusSignalTrace[];
}

export interface ResolvedStatusEventData {
  subjectId: string;
  state: WorkerStatusState;
  basis: AgentStatusBasis;
  tier: AgentStatusTier;
  source: string;
  confidence: number;
  observedAt: string;
  provenance?: AgentStatusSourceProvenance;
  winner: StatusSignalTrace;
  observedSignal: StatusSignalTrace;
  attention: StatusSignalTrace[];
  attentionRaised: boolean;
  signalCount: number;
}

interface SignalContext {
  eventId?: string;
  eventType?: string;
}

interface StoredSignal extends AgentStatusSignal, SignalContext {
  sequence: number;
}

interface IdentifiedSignal {
  subjectId: string;
  signal: AgentStatusSignal;
}

const ATTENTION_STATES = new Set<WorkerStatusState>(["waiting_user", "blocked", "failed"]);
const TERMINAL_TIER_ONE_BASES = new Set<AgentStatusBasis>([
  "worker_settled",
  "worker_failed",
  "worker_offline",
  "captain_offline",
]);

export class AgentStatusResolver {
  private readonly histories = new Map<string, StoredSignal[]>();

  public ingest(
    subjectId: string,
    input: AgentStatusSignalInput,
    context: SignalContext = {},
  ): ResolvedAgentStatus {
    if (subjectId.trim().length === 0) throw new Error("Status subject id must not be empty");
    const signal = parseSignal(input);
    const history = this.histories.get(subjectId) ?? [];
    history.push({ ...signal, ...context, sequence: history.length + 1 });
    this.histories.set(subjectId, history);
    return resolveHistory(subjectId, history);
  }

  public ingestDomainEvent(event: DomainEvent): ResolvedAgentStatus | undefined {
    const identified = statusSignalFromEvent(event);
    if (!identified) return undefined;
    return this.ingest(identified.subjectId, identified.signal, {
      eventId: event.id,
      eventType: event.type,
    });
  }

  public explain(subjectId: string): ResolvedAgentStatus | undefined {
    const history = this.histories.get(subjectId);
    return history ? resolveHistory(subjectId, history) : undefined;
  }

  public list(): ResolvedAgentStatus[] {
    return [...this.histories.keys()]
      .sort()
      .map((subjectId) => this.explain(subjectId))
      .filter((status): status is ResolvedAgentStatus => status !== undefined);
  }

  public static replay(events: readonly DomainEvent[]): AgentStatusResolver {
    const resolver = new AgentStatusResolver();
    for (const event of events) resolver.ingestDomainEvent(event);
    return resolver;
  }
}

export function statusSignalFromEvent(event: DomainEvent): IdentifiedSignal | undefined {
  const subjectId = statusSubject(event);
  if (!subjectId) return undefined;

  const captainEvent = CaptainPresenceEventSchema.safeParse(event);
  if (captainEvent.success) {
    return { subjectId, signal: captainSignal(captainEvent.data) };
  }

  if (event.type === STATUS_SIGNAL_EVENT_TYPE) {
    const signal = parseExternalSignal(event.data);
    return signal ? { subjectId, signal } : undefined;
  }

  if (event.type === "worker.turn.started") {
    return tierZeroSignal(event, subjectId, "working", "turn_started");
  }
  if (event.type === "worker.turn.settled") {
    return tierZeroSignal(event, subjectId, "idle", "turn_settled");
  }
  if (event.type === "worker.waiting_user") {
    return tierZeroSignal(event, subjectId, "waiting_user", "waiting_user");
  }

  const tierOne = tierOneSignal(event);
  return tierOne ? { subjectId, signal: tierOne } : undefined;
}

function captainSignal(event: ReturnType<typeof CaptainPresenceEventSchema.parse>): AgentStatusSignal {
  const { data } = event;
  if (event.type === "captain.presence.offline") {
    return { ...data, basis: "captain_offline" };
  }
  if (event.type === "captain.presence.online" || event.type === "captain.heartbeat") {
    return { ...data, basis: "captain_presence" };
  }
  if (event.type === "captain.turn.started") {
    return { ...data, basis: "turn_started" };
  }
  if (event.type === "captain.waiting_dependency") {
    return { ...data, basis: "waiting_dependency" };
  }
  return {
    ...data,
    basis: data.state === "waiting_user" ? "waiting_user" : "turn_settled",
    ...(data.state === "waiting_user" ? { questionSummary: data.questionSummary } : {}),
  };
}

export function toResolvedStatusEventData(status: ResolvedAgentStatus): ResolvedStatusEventData {
  const observedSignal = status.signalChain.at(-1);
  if (!observedSignal) throw new Error(`Resolved status ${status.subjectId} has no signal trail`);
  return {
    subjectId: status.subjectId,
    state: status.state,
    basis: status.basis,
    tier: status.tier,
    source: status.source,
    confidence: status.confidence,
    observedAt: status.observedAt,
    ...(status.provenance ? { provenance: structuredClone(status.provenance) } : {}),
    winner: structuredClone(status.winner),
    observedSignal: structuredClone(observedSignal),
    attention: structuredClone(status.attention),
    attentionRaised: status.attention.length > 0,
    signalCount: status.signalChain.length,
  };
}

export function explainStatusFromEvents(
  events: readonly DomainEvent[],
  subjectId: string,
): ResolvedAgentStatus | undefined {
  return AgentStatusResolver.replay(events).explain(subjectId);
}

export function formatStatusExplain(status: ResolvedAgentStatus): string {
  const lines = [
    `Status explain: ${status.subjectId}`,
    `Current: ${status.state} (${status.basis})`,
    `Winner: tier ${String(status.winner.tier)} · ${status.winner.source} · confidence ${status.winner.confidence.toFixed(2)} · ${status.winner.observedAt}${formatDegradation(status.winner.degradation)}`,
    "Signal chain:",
  ];
  for (const signal of status.signalChain) {
    lines.push(
      `- #${String(signal.sequence)} [${signal.disposition}] ${signal.state} (${signal.basis}) · tier ${String(signal.tier)} · ${signal.source} · confidence ${signal.confidence.toFixed(2)} · ${signal.observedAt}${signal.eventType ? ` · ${signal.eventType}` : ""}${formatDegradation(signal.degradation)}`,
    );
  }
  if (status.attention.length > 0) {
    lines.push("Attention-only signals:");
    for (const signal of status.attention) {
      lines.push(
        `- ${signal.state} · tier ${String(signal.tier)} · ${signal.source} · ${signal.observedAt}${signal.questionSummary ? ` · ${signal.questionSummary}` : ""}${formatDegradation(signal.degradation)}`,
      );
    }
  }
  return lines.join("\n");
}

function resolveHistory(subjectId: string, history: readonly StoredSignal[]): ResolvedAgentStatus {
  const terminalIndex = findLastIndex(
    history,
    (signal) => signal.tier === 1 && TERMINAL_TIER_ONE_BASES.has(signal.basis),
  );
  const activeStart = terminalIndex < 0 ? 0 : terminalIndex;
  const active = history.slice(activeStart);
  const knownHigherTier = active.filter((signal) => signal.tier < 2 && signal.state !== "unknown");
  const knownTierTwo = active.filter((signal) => signal.tier === 2 && signal.state !== "unknown");
  const unknown = active.filter((signal) => signal.state === "unknown");
  const winner =
    chooseByTier(knownHigherTier) ?? chooseLatest(knownTierTwo) ?? chooseByTier(unknown) ?? active.at(-1);
  if (!winner) throw new Error(`Status subject ${subjectId} has no signals`);

  const latestTierTwo = chooseLatest(active.filter((signal) => signal.tier === 2));
  const attentionSequences = new Set(
    latestTierTwo && latestTierTwo.sequence !== winner.sequence && ATTENTION_STATES.has(latestTierTwo.state)
      ? [latestTierTwo.sequence]
      : [],
  );
  const chain = history.map((signal) =>
    traceSignal(
      signal,
      signal.sequence === winner.sequence
        ? "winner"
        : signal.sequence - 1 < activeStart && terminalIndex >= 0
          ? "invalidated"
          : attentionSequences.has(signal.sequence)
            ? "attention_only"
            : signal.state === "unknown" && winner.tier === 2
              ? "unknown_filled"
              : "superseded",
    ),
  );
  const winnerTrace = chain.find((signal) => signal.sequence === winner.sequence);
  if (!winnerTrace) throw new Error(`Status subject ${subjectId} lost its winning signal`);
  return {
    subjectId,
    state: winnerTrace.state,
    basis: winnerTrace.basis,
    tier: winnerTrace.tier,
    source: winnerTrace.source,
    confidence: winnerTrace.confidence,
    observedAt: winnerTrace.observedAt,
    ...(winnerTrace.provenance ? { provenance: structuredClone(winnerTrace.provenance) } : {}),
    winner: structuredClone(winnerTrace),
    signalChain: chain,
    attention: chain.filter((signal) => signal.disposition === "attention_only"),
  };
}

function tierZeroSignal(
  event: DomainEvent,
  subjectId: string,
  state: WorkerStatusState,
  basis: AgentStatusBasis,
): IdentifiedSignal | undefined {
  const provenance = WorkerStatusProvenanceSchema.safeParse(event.data);
  if (!provenance.success || provenance.data.tier !== 0) return undefined;
  const questionSummary = normalizedQuestion(event.data.questionSummary);
  return {
    subjectId,
    signal: {
      state,
      basis,
      ...provenance.data,
      ...(questionSummary ? { questionSummary } : {}),
    },
  };
}

function tierOneSignal(event: DomainEvent): AgentStatusSignal | undefined {
  const mapped = tierOneState(event);
  if (!mapped) return undefined;
  return {
    state: mapped.state,
    basis: mapped.basis,
    tier: 1,
    source: mapped.source,
    confidence: 1,
    observedAt: event.occurredAt,
  };
}

function tierOneState(event: DomainEvent): Pick<AgentStatusSignal, "state" | "basis" | "source"> | undefined {
  if (
    [
      "worker.leased",
      "worker.started",
      "worker.lease.registered",
      "worker.lease.renewed",
      "worker.readopted",
    ].includes(event.type)
  ) {
    return { state: "working", basis: "worker_active", source: "runner.lifecycle" };
  }
  if (event.type === "worker.waiting_dependency") {
    return {
      state: "waiting_dependency",
      basis: "waiting_dependency",
      source: "runner.scheduler",
    };
  }
  if (event.type === "worker.lost" || event.type === "worker.lease.expired") {
    return { state: "offline", basis: "worker_offline", source: "runner.process_lease" };
  }
  if (event.type === "worker.crashed") {
    return { state: "failed", basis: "worker_failed", source: "runner.process_exit" };
  }
  if (event.type === "worker.cancelled") {
    return { state: "completed", basis: "worker_settled", source: "runner.process_exit" };
  }
  if (event.type === "worker.settled" || event.type === "worker.completed") {
    const result = settlementResult(event.data.result);
    return {
      state: result === "succeeded" ? "completed" : result === "blocked" ? "blocked" : "failed",
      basis: "worker_settled",
      source: "mission-engine.settlement",
    };
  }
  return undefined;
}

function settlementResult(value: unknown): "succeeded" | "failed" | "blocked" {
  const candidate =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? (value as Record<string, unknown>).status
        : undefined;
  return candidate === "succeeded" || candidate === "blocked" ? candidate : "failed";
}

function parseExternalSignal(data: Record<string, unknown>): AgentStatusSignal | undefined {
  const state = WorkerStatusStateSchema.safeParse(data.state);
  const provenance = WorkerStatusProvenanceSchema.safeParse(data);
  if (!state.success || !provenance.success || provenance.data.tier === 0) return undefined;
  const basis =
    typeof data.basis === "string" && isStatusBasis(data.basis)
      ? data.basis
      : provenance.data.tier === 2
        ? "heuristic"
        : inferTierOneBasis(state.data);
  const questionSummary = normalizedQuestion(data.questionSummary);
  const degradation = parseDegradation(data.degradation);
  const sourceProvenance = parseSourceProvenance(data.provenance);
  return {
    state: state.data,
    basis,
    ...provenance.data,
    ...(questionSummary ? { questionSummary } : {}),
    ...(degradation ? { degradation } : {}),
    ...(sourceProvenance ? { provenance: sourceProvenance } : {}),
  };
}

function parseSignal(input: AgentStatusSignalInput): AgentStatusSignal {
  const state = WorkerStatusStateSchema.parse(input.state);
  const provenance = WorkerStatusProvenanceSchema.parse(input);
  const questionSummary = normalizedQuestion(input.questionSummary);
  const degradation = parseDegradation(input.degradation);
  const sourceProvenance = parseSourceProvenance(input.provenance);
  return {
    state,
    ...provenance,
    basis: input.basis ?? (provenance.tier === 2 ? "heuristic" : "external_signal"),
    ...(questionSummary ? { questionSummary } : {}),
    ...(degradation ? { degradation } : {}),
    ...(sourceProvenance ? { provenance: sourceProvenance } : {}),
  };
}

function statusSubject(event: DomainEvent): string | undefined {
  if (event.workerRunId) return event.workerRunId;
  return typeof event.data.subjectId === "string" && event.data.subjectId.trim().length > 0
    ? event.data.subjectId
    : undefined;
}

function normalizedQuestion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseDegradation(value: unknown): AgentStatusDegradation | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const code = normalizedText(candidate.code, 120);
  const error = normalizedText(candidate.error, 512);
  const consecutiveFailures = candidate.consecutiveFailures;
  if (
    code === undefined ||
    error === undefined ||
    !Number.isSafeInteger(consecutiveFailures) ||
    (consecutiveFailures as number) <= 0
  ) {
    return undefined;
  }
  const retryAt = candidate.retryAt;
  const validRetryAt =
    typeof retryAt === "string" && Number.isFinite(Date.parse(retryAt))
      ? new Date(retryAt).toISOString()
      : undefined;
  return {
    code,
    error,
    consecutiveFailures: consecutiveFailures as number,
    ...(validRetryAt ? { retryAt: validRetryAt } : {}),
  };
}

function parseSourceProvenance(value: unknown): AgentStatusSourceProvenance | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "herdr_pane") return undefined;
  const workspaceId = normalizedText(candidate.workspaceId, 512);
  const paneId = normalizedText(candidate.paneId, 512);
  if (!workspaceId || !paneId) return undefined;
  const agent = normalizedText(candidate.agent, 256);
  return {
    kind: "herdr_pane",
    workspaceId,
    paneId,
    ...(agent ? { agent } : {}),
  };
}

function normalizedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 0 ? normalized.slice(0, limit) : undefined;
}

function formatDegradation(degradation: AgentStatusDegradation | undefined): string {
  if (degradation === undefined) return "";
  return ` · degraded ${degradation.code}: ${degradation.error} · failures ${String(degradation.consecutiveFailures)}${degradation.retryAt ? ` · retry ${degradation.retryAt}` : ""}`;
}

function inferTierOneBasis(state: WorkerStatusState): AgentStatusBasis {
  if (state === "completed") return "worker_settled";
  if (state === "failed" || state === "blocked") return "worker_failed";
  if (state === "offline") return "worker_offline";
  if (state === "waiting_dependency") return "waiting_dependency";
  return "external_signal";
}

function chooseByTier(signals: readonly StoredSignal[]): StoredSignal | undefined {
  const sorted = [...signals].sort((left, right) => left.tier - right.tier || right.sequence - left.sequence);
  return sorted[0];
}

function chooseLatest(signals: readonly StoredSignal[]): StoredSignal | undefined {
  return signals.reduce<StoredSignal | undefined>(
    (latest, signal) => (!latest || signal.sequence > latest.sequence ? signal : latest),
    undefined,
  );
}

function traceSignal(signal: StoredSignal, disposition: StatusSignalDisposition): StatusSignalTrace {
  return { ...signal, disposition };
}

function findLastIndex<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== undefined && predicate(value)) return index;
  }
  return -1;
}

function isStatusBasis(value: string): value is AgentStatusBasis {
  return [
    "external_signal",
    "heuristic",
    "turn_started",
    "turn_settled",
    "waiting_user",
    "waiting_dependency",
    "captain_presence",
    "captain_offline",
    "worker_active",
    "worker_settled",
    "worker_failed",
    "worker_offline",
  ].includes(value);
}

export * from "./herdr.ts";
