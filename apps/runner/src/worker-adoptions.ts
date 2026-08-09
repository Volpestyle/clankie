import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { EventStore } from "@clankie/event-store";
import { createLogger } from "@clankie/observability";
import {
  AgentDeclarationSchema,
  WorkerAdoptionSchema,
  eventStreamKindForId,
  type AdoptWorkerCommand,
  type AdoptWorkerResult,
  type AgentDeclaration,
  type AgentObservation,
  type DomainEvent,
  type WorkerAdoption,
  type WorkerAdoptionLapseReason,
  type WorkerAdoptionPrincipal,
} from "@clankie/protocol";

const logger = createLogger({ service: "clankie-runner-worker-adoptions", version: "0.1.0" });

const ADOPTIONS_DIR = "worker-adoptions";
const DECLARATIONS_DIR = "agent-declarations";
const DECLARATION_MAX_BYTES = 8 * 1024;
/** A declaration is a live status, not an archive; a stale one is not read. */
const DECLARATION_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

export interface ReconcileAdoptionsReport {
  retained: WorkerAdoption[];
  lapsed: WorkerAdoption[];
  corruptRemoved: string[];
}

export interface WorkerAdoptionStoreOptions {
  /** State root; adoption records live under `<rootDir>/worker-adoptions`. */
  rootDir: string;
  events: EventStore;
  clock?: () => Date;
  idFactory?: () => string;
  /** Profile hash stamped onto adoption events; adoption predates any mission. */
  profileHash?: string;
}

/**
 * Durable records for agents this runner did not start (ADR 0078).
 *
 * The contract that makes adoption safe is narrow and enforced here rather than
 * by callers: only a pane the transport identified as a real agent session is
 * adoptable, a `directed` adoption must declare its expected write scope and
 * receives a whole-workspace scheduler reservation, an `observed` one must
 * declare none, and a binding whose native session or workspace no longer
 * matches lapses explicitly instead of silently re-pointing.
 *
 * Adoption events use the reserved `adoption:<adoptionId>` stream (ADR 0065)
 * because an adopted agent has no mission of its own — it existed before any
 * mission wanted it, and may outlive the one that borrows it.
 */
export class WorkerAdoptionStore {
  private readonly rootDir: string;
  private readonly events: EventStore;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly profileHash: string;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(options: WorkerAdoptionStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    this.events = options.events;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.profileHash = options.profileHash ?? "unknown";
  }

  /**
   * Take bounded responsibility for a live agent. Refusals are typed and
   * total: every path that does not produce a record says why, so a caller
   * never has to distinguish "refused" from "failed".
   */
  public adopt(
    request: AdoptWorkerCommand,
    observation: AgentObservation | undefined,
    ownedSessionIds: ReadonlySet<string> = new Set(),
  ): Promise<AdoptWorkerResult> {
    return this.enqueue(async () => {
      if (request.grade === "directed" && request.writeScope.length === 0) {
        return { outcome: "refused", reason: "write_scope_required" } as const;
      }
      if (request.grade === "observed" && request.writeScope.length > 0) {
        return { outcome: "refused", reason: "write_scope_forbidden" } as const;
      }
      if (
        !observation ||
        observation.terminalId !== request.terminalId ||
        observation.transport !== request.transport ||
        observation.transportInstanceId !== request.transportInstanceId
      ) {
        return { outcome: "refused", reason: "not_found" } as const;
      }
      if (observation.workspace.workspaceId !== request.workspaceId) {
        return { outcome: "refused", reason: "workspace_mismatch" } as const;
      }
      if (!observation.adoptable || !observation.harness || !observation.agentSessionId) {
        return { outcome: "refused", reason: "not_an_agent" } as const;
      }
      if (request.grade === "directed") {
        const approval = request.approval;
        if (
          approval === undefined ||
          request.adoptedBy.kind !== "operator" ||
          approval.approvedBy.kind !== "operator" ||
          approval.approvedBy.id !== request.adoptedBy.id
        ) {
          return { outcome: "refused", reason: "approval_required" } as const;
        }
      }
      if (ownedSessionIds.has(observation.agentSessionId)) {
        return { outcome: "refused", reason: "already_owned" } as const;
      }
      const existing = (await this.readAll()).adoptions.find(
        (record) =>
          record.state === "active" &&
          record.binding.transport === request.transport &&
          record.binding.transportInstanceId === request.transportInstanceId &&
          record.binding.agentSessionId === observation.agentSessionId,
      );
      if (existing) return { outcome: "refused", reason: "already_adopted" } as const;

      const now = this.clock().toISOString();
      const parsed = WorkerAdoptionSchema.parse({
        schemaVersion: 1,
        adoptionId: this.idFactory(),
        workerRunId: this.idFactory(),
        grade: request.grade,
        state: "active",
        binding: {
          transport: request.transport,
          transportInstanceId: request.transportInstanceId,
          terminalId: request.terminalId,
          harness: observation.harness,
          agentSessionId: observation.agentSessionId,
          workspace: observation.workspace,
        },
        writeScope: [...request.writeScope],
        reservedWriteScope: request.grade === "directed" ? ["**"] : [],
        adoptedBy: request.adoptedBy,
        ...(request.approval === undefined ? {} : { approval: request.approval }),
        adoptedAt: now,
        updatedAt: now,
      } satisfies WorkerAdoption);
      await this.persist(parsed);
      await this.record("worker.adopted", parsed, {
        grade: parsed.grade,
        transport: parsed.binding.transport,
        harness: parsed.binding.harness,
        writeScopeCount: parsed.writeScope.length,
        adoptedByKind: parsed.adoptedBy.kind,
        adoptedById: parsed.adoptedBy.id,
      });
      logger.info(
        {
          adoptionId: parsed.adoptionId,
          grade: parsed.grade,
          transport: parsed.binding.transport,
          harness: parsed.binding.harness,
          writeScopeCount: parsed.writeScope.length,
        },
        "agent adopted",
      );
      return { outcome: "adopted", adoption: parsed } as const;
    });
  }

  /** Give the agent back. Idempotent: releasing a released adoption is a no-op. */
  public release(adoptionId: string, releasedBy: WorkerAdoptionPrincipal): Promise<void> {
    return this.enqueue(async () => {
      const adoption = await this.read(adoptionId);
      if (!adoption || adoption.state === "released") return;
      // A released record drops any lapse reason: the schema allows one only
      // while the state is `lapsed`, and release is a decision, not a cause.
      const { lapseReason: _lapseReason, ...rest } = adoption;
      const parsed = WorkerAdoptionSchema.parse({
        ...rest,
        state: "released",
        updatedAt: this.clock().toISOString(),
      });
      await this.persist(parsed);
      await this.record("worker.adoption.released", parsed, {
        releasedByKind: releasedBy.kind,
        releasedById: releasedBy.id,
      });
    });
  }

  /**
   * Startup reconciliation. Every active binding is re-verified against what
   * the transport can currently see; a broken one lapses rather than being
   * re-pointed. Running it again is a no-op, because a lapsed record is never
   * re-checked.
   *
   * An unavailable transport lapses nothing. "I cannot see" is not evidence
   * that an agent stopped, and lapsing on it would discard live adoptions every
   * time the socket blinked.
   */
  public reconcile(observations: readonly AgentObservation[] | undefined): Promise<ReconcileAdoptionsReport> {
    return this.enqueue(async () => {
      const report: ReconcileAdoptionsReport = { retained: [], lapsed: [], corruptRemoved: [] };
      const { adoptions, corrupt } = await this.readAll();
      for (const file of corrupt) {
        await unlink(file).catch(() => undefined);
        report.corruptRemoved.push(file);
        logger.error({ file }, "corrupt adoption record removed during reconciliation");
      }
      const active = adoptions.filter((adoption) => adoption.state === "active");
      if (observations === undefined) {
        report.retained.push(...active);
        logger.warn(
          { retained: report.retained.length },
          "adoption reconciliation skipped: transport unavailable, nothing lapsed",
        );
        return report;
      }
      const byTerminal = new Map(
        observations.map((observation) => [
          terminalKey(observation.transport, observation.transportInstanceId, observation.terminalId),
          observation,
        ]),
      );
      for (const adoption of active) {
        const observation = byTerminal.get(
          terminalKey(
            adoption.binding.transport,
            adoption.binding.transportInstanceId,
            adoption.binding.terminalId,
          ),
        );
        const lapseReason = lapseReasonFor(adoption, observation);
        if (lapseReason === undefined) {
          report.retained.push(adoption);
          continue;
        }
        const parsed = WorkerAdoptionSchema.parse({
          ...adoption,
          state: "lapsed",
          lapseReason,
          updatedAt: this.clock().toISOString(),
        });
        await this.persist(parsed);
        await this.record("worker.adoption.lapsed", parsed, { lapseReason });
        report.lapsed.push(parsed);
      }
      logger.info(
        {
          retained: report.retained.length,
          lapsed: report.lapsed.length,
          corruptRemoved: report.corruptRemoved.length,
        },
        "adoption reconciliation complete",
      );
      return report;
    });
  }

  /**
   * Receipt for one delivered direction. It records that something was said and
   * how long it was, never the text: steering content is untrusted model or
   * operator prose, and the audit question is who directed whom and when.
   */
  public recordDirection(
    adoption: WorkerAdoption,
    directedBy: WorkerAdoptionPrincipal,
    textLength: number,
  ): Promise<void> {
    return this.enqueue(async () => {
      await this.record("worker.adoption.directed", adoption, {
        directedByKind: directedBy.kind,
        directedById: directedBy.id,
        textLength,
      });
    });
  }

  public list(): Promise<WorkerAdoption[]> {
    return this.enqueue(async () => (await this.readAll()).adoptions);
  }

  /** Active adoptions only — what steering and contention checks consult. */
  public async active(): Promise<WorkerAdoption[]> {
    return (await this.list()).filter((adoption) => adoption.state === "active");
  }

  /**
   * The cooperative half of the census: a bounded record an agent writes about
   * itself. Unparseable, oversized, mismatched, and stale files are ignored
   * rather than surfaced — a malformed declaration must not become a census
   * entry that looks authoritative.
   */
  public async readDeclaration(observation: AgentObservation): Promise<AgentDeclaration | undefined> {
    let raw: string;
    try {
      raw = await readFile(
        agentDeclarationPath(this.rootDir, observation.transportInstanceId, observation.terminalId),
        "utf8",
      );
    } catch {
      return undefined;
    }
    if (raw.length > DECLARATION_MAX_BYTES) return undefined;
    const parsed = AgentDeclarationSchema.safeParse(safeJsonParse(raw));
    if (!parsed.success) return undefined;
    if (
      parsed.data.terminalId !== observation.terminalId ||
      parsed.data.transportInstanceId !== observation.transportInstanceId ||
      parsed.data.workspaceId !== observation.workspace.workspaceId
    ) {
      return undefined;
    }
    const age = this.clock().getTime() - Date.parse(parsed.data.declaredAt);
    if (!Number.isFinite(age) || age < 0 || age > DECLARATION_MAX_AGE_MS) return undefined;
    return parsed.data;
  }

  private async record(type: string, adoption: WorkerAdoption, data: Record<string, unknown>): Promise<void> {
    const streamId = `adoption:${adoption.adoptionId}`;
    const event: DomainEvent = {
      id: randomUUID(),
      occurredAt: this.clock().toISOString(),
      missionId: streamId,
      streamKind: eventStreamKindForId(streamId),
      workerRunId: adoption.workerRunId,
      correlationId: adoption.workerRunId,
      profileHash: this.profileHash,
      type,
      data: { adoptionId: adoption.adoptionId, terminalId: adoption.binding.terminalId, ...data },
    };
    await this.events.append(event);
  }

  private async persist(adoption: WorkerAdoption): Promise<void> {
    await mkdir(join(this.rootDir, ADOPTIONS_DIR), { recursive: true });
    // Atomic write: a crash mid-persist must never tear a live adoption record.
    const target = this.adoptionFile(adoption.adoptionId);
    const temporary = `${target}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(adoption, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  private async read(adoptionId: string): Promise<WorkerAdoption | undefined> {
    try {
      const parsed = WorkerAdoptionSchema.safeParse(
        safeJsonParse(await readFile(this.adoptionFile(adoptionId), "utf8")),
      );
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  private async readAll(): Promise<{ adoptions: WorkerAdoption[]; corrupt: string[] }> {
    let files: string[];
    try {
      files = await readdir(join(this.rootDir, ADOPTIONS_DIR));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { adoptions: [], corrupt: [] };
      throw error;
    }
    const adoptions: WorkerAdoption[] = [];
    const corrupt: string[] = [];
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      const path = join(this.rootDir, ADOPTIONS_DIR, file);
      const parsed = WorkerAdoptionSchema.safeParse(safeJsonParse(await readFile(path, "utf8")));
      if (parsed.success) adoptions.push(parsed.data);
      else corrupt.push(path);
    }
    // Stable order so a census taken twice from the same state is identical.
    adoptions.sort((left, right) => left.adoptionId.localeCompare(right.adoptionId));
    return { adoptions, corrupt };
  }

  private adoptionFile(adoptionId: string): string {
    return join(this.rootDir, ADOPTIONS_DIR, `${encodeURIComponent(adoptionId)}.json`);
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/**
 * A lapse is always a fact about the agent, never an inference from silence.
 * An idle adopted agent stays active; only a replaced session or a vanished
 * terminal ends the adoption.
 */
function lapseReasonFor(
  adoption: WorkerAdoption,
  observation: AgentObservation | undefined,
): WorkerAdoptionLapseReason | undefined {
  if (!observation) return "terminal_gone";
  if (!observation.adoptable || observation.harness !== adoption.binding.harness) {
    return "session_replaced";
  }
  if (observation.agentSessionId === undefined) return "session_replaced";
  if (observation.agentSessionId !== adoption.binding.agentSessionId) return "session_replaced";
  if (
    observation.workspace.workspaceId !== adoption.binding.workspace.workspaceId ||
    observation.workspace.root !== adoption.binding.workspace.root
  ) {
    return "workspace_changed";
  }
  return undefined;
}

/** Path an agent writes its self-declaration to, keyed by transport instance plus terminal. */
export function agentDeclarationPath(
  rootDir: string,
  transportInstanceId: string,
  terminalId: string,
): string {
  return join(
    resolve(rootDir),
    DECLARATIONS_DIR,
    `${encodeURIComponent(transportInstanceId)}--${encodeURIComponent(terminalId)}.json`,
  );
}

function terminalKey(transport: string, transportInstanceId: string, terminalId: string): string {
  return `${transport}:${transportInstanceId}:${terminalId}`;
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
