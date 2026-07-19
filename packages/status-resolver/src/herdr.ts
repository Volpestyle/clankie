import type { AgentStatusSignalInput, AgentStatusSourceProvenance, ResolvedAgentStatus } from "./index.ts";

export const HERDR_AGENT_STATUS_CHANGED_EVENT = "pane.agent_status_changed";

export type HerdrAgentStatus = "working" | "blocked" | "idle" | "done" | "unknown";

export interface HerdrPaneIdentity {
  workspaceId: string;
  paneId: string;
  agent?: string;
}

export interface HerdrPaneAgentStatusChangedPayload {
  pane_id: string;
  workspace_id: string;
  agent_status: HerdrAgentStatus;
  agent?: string;
}

export interface HerdrPaneAgentStatusChangedEvent {
  event: typeof HERDR_AGENT_STATUS_CHANGED_EVENT;
  data: HerdrPaneAgentStatusChangedPayload;
}

export interface HerdrAgentStatusIngest {
  identity: HerdrPaneIdentity;
  signal: AgentStatusSignalInput;
}

export type HerdrStatusEventRegistrar = (listener: (event: unknown) => void) => void | (() => void);

export interface RegisterHerdrStatusIngestOptions {
  env?: Readonly<Record<string, string | undefined>>;
  register: HerdrStatusEventRegistrar;
  resolveSubjectId: (identity: HerdrPaneIdentity) => string | undefined;
  ingest: (subjectId: string, signal: AgentStatusSignalInput) => void | ResolvedAgentStatus;
  clock?: () => Date;
}

export interface HerdrStatusRegistration {
  unregister(): void;
}

const HERDR_STATES: readonly HerdrAgentStatus[] = ["working", "blocked", "idle", "done", "unknown"];

const RESOLVER_STATE_BY_HERDR_STATUS = {
  working: "working",
  blocked: "blocked",
  idle: "idle",
  done: "completed",
  unknown: "unknown",
} as const;

/**
 * Convert a parsed Herdr socket event into the resolver's untrusted Tier-2
 * signal model. The caller supplies the receive timestamp because Herdr's
 * event envelope does not carry one.
 */
export function herdrAgentStatusSignalFromEvent(
  event: unknown,
  observedAt: string,
): HerdrAgentStatusIngest | undefined {
  if (!isRecord(event) || event.event !== HERDR_AGENT_STATUS_CHANGED_EVENT) return undefined;
  return herdrAgentStatusSignalFromPayload(event.data, observedAt);
}

/** Pure payload mapper used when a socket client has already removed the event envelope. */
export function herdrAgentStatusSignalFromPayload(
  payload: unknown,
  observedAt: string,
): HerdrAgentStatusIngest | undefined {
  if (!isRecord(payload)) return undefined;
  const workspaceId = boundedText(payload.workspace_id, 512);
  const paneId = boundedText(payload.pane_id, 512);
  const agentStatus = payload.agent_status;
  const normalizedObservedAt = isoTimestamp(observedAt);
  if (!workspaceId || !paneId || !isHerdrAgentStatus(agentStatus) || normalizedObservedAt === undefined) {
    return undefined;
  }

  const agent = boundedText(payload.agent, 256);
  const identity: HerdrPaneIdentity = {
    workspaceId,
    paneId,
    ...(agent ? { agent } : {}),
  };
  const provenance: AgentStatusSourceProvenance = {
    kind: "herdr_pane",
    ...identity,
  };
  return {
    identity,
    signal: {
      state: RESOLVER_STATE_BY_HERDR_STATUS[agentStatus],
      tier: 2,
      source: "herdr",
      confidence: 1,
      observedAt: normalizedObservedAt,
      basis: "heuristic",
      provenance,
    },
  };
}

/**
 * Register optional Herdr ingestion. Outside exact `HERDR_ENV=1`, this does
 * not invoke the registrar and therefore opens no socket or event stream.
 *
 * Herdr pane ids are session-local and reusable, so the runtime must map the
 * supplied identity to its canonical status subject rather than using paneId
 * as a durable subject id.
 */
export function registerHerdrStatusIngest(
  options: RegisterHerdrStatusIngestOptions,
): HerdrStatusRegistration | undefined {
  const env = options.env ?? process.env;
  if (env.HERDR_ENV !== "1") return undefined;

  const unregister = options.register((event) => {
    const observedAt = (options.clock ?? (() => new Date()))().toISOString();
    const mapped = herdrAgentStatusSignalFromEvent(event, observedAt);
    if (!mapped) return;
    const subjectId = options.resolveSubjectId(mapped.identity)?.trim();
    if (!subjectId) return;
    options.ingest(subjectId, mapped.signal);
  });

  return { unregister: unregister ?? (() => undefined) };
}

function isHerdrAgentStatus(value: unknown): value is HerdrAgentStatus {
  return typeof value === "string" && HERDR_STATES.includes(value as HerdrAgentStatus);
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined;
}

function isoTimestamp(value: string): string | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
