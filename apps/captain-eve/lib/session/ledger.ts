import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  SqliteEventStore,
  type ChainVerification,
  type EventStore,
  type StoredEvent,
} from "@clankie/event-store";
import type { CaptainContextBudget } from "./context-budget.ts";
import {
  addTokenUsage,
  normalizeTokenUsage,
  ZERO_TOKEN_USAGE,
  type CaptainTokenUsage,
} from "./token-usage.ts";

export type CaptainSessionState = "active" | "waiting" | "completed" | "failed";

export interface CaptainSessionSnapshot {
  readonly projectId: string;
  readonly sessionId: string;
  readonly state: CaptainSessionState;
  readonly modelRef?: string;
  readonly budget?: CaptainContextBudget;
  readonly usage: CaptainTokenUsage;
  readonly lastInputTokens: number;
  readonly compactions: {
    readonly requested: number;
    readonly completed: number;
  };
  readonly lastTurnId?: string;
  readonly updatedAt?: string;
}

interface LedgerEvent {
  readonly eventKey: string;
  readonly occurredAt: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly type: string;
  readonly data?: Record<string, unknown>;
}

const LEDGER_PROFILE_HASH = createHash("sha256").update("captain-session-ledger:v1").digest("hex");

function eventId(projectId: string, event: LedgerEvent): string {
  return createHash("sha256")
    .update([projectId, event.sessionId, event.type, event.eventKey].join("\0"))
    .digest("hex");
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function budgetValue(value: unknown): CaptainContextBudget | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const context = numberValue(record.context);
  const reserved = numberValue(record.reserved);
  const usable = numberValue(record.usable);
  return context > 0 && reserved >= 0 && usable > 0 ? { context, reserved, usable } : undefined;
}

export class CaptainSessionLedger {
  private readonly store: EventStore;
  private readonly closeStore: (() => void) | undefined;
  public readonly projectId: string;

  public constructor(projectId: string, store: EventStore, closeStore?: () => void) {
    this.projectId = projectId;
    this.store = store;
    this.closeStore = closeStore;
  }

  public recordStarted(
    sessionId: string,
    eventKey: string,
    occurredAt: string,
    turnId?: string,
  ): Promise<StoredEvent> {
    return this.record({
      sessionId,
      eventKey,
      occurredAt,
      type: "captain.session.started",
      ...(turnId === undefined ? {} : { turnId }),
    });
  }

  public recordModelSelection(input: {
    sessionId: string;
    eventKey: string;
    occurredAt: string;
    turnId: string;
    modelRef: string;
    budget?: CaptainContextBudget;
  }): Promise<StoredEvent> {
    return this.record({
      sessionId: input.sessionId,
      eventKey: input.eventKey,
      occurredAt: input.occurredAt,
      turnId: input.turnId,
      type: "captain.session.model_selected",
      data: {
        modelRef: input.modelRef,
        ...(input.budget === undefined ? {} : { budget: input.budget }),
      },
    });
  }

  public recordTurnStarted(
    sessionId: string,
    eventKey: string,
    occurredAt: string,
    turnId: string,
  ): Promise<StoredEvent> {
    return this.record({
      sessionId,
      eventKey,
      occurredAt,
      turnId,
      type: "captain.session.turn_started",
    });
  }

  public recordUsage(input: {
    sessionId: string;
    eventKey: string;
    occurredAt: string;
    turnId: string;
    usage: CaptainTokenUsage;
  }): Promise<StoredEvent> {
    return this.record({
      sessionId: input.sessionId,
      eventKey: input.eventKey,
      occurredAt: input.occurredAt,
      turnId: input.turnId,
      type: "captain.session.usage_recorded",
      data: { usage: input.usage },
    });
  }

  public recordCompaction(input: {
    sessionId: string;
    eventKey: string;
    occurredAt: string;
    turnId: string;
    phase: "requested" | "completed";
    usageInputTokens?: number;
  }): Promise<StoredEvent> {
    return this.record({
      sessionId: input.sessionId,
      eventKey: input.eventKey,
      occurredAt: input.occurredAt,
      turnId: input.turnId,
      type: `captain.session.compaction_${input.phase}`,
      data: input.usageInputTokens === undefined ? {} : { usageInputTokens: input.usageInputTokens },
    });
  }

  public recordBoundary(input: {
    sessionId: string;
    eventKey: string;
    occurredAt: string;
    turnId: string;
    state: Exclude<CaptainSessionState, "active">;
  }): Promise<StoredEvent> {
    return this.record({
      sessionId: input.sessionId,
      eventKey: input.eventKey,
      occurredAt: input.occurredAt,
      turnId: input.turnId,
      type: `captain.session.${input.state}`,
    });
  }

  public async snapshot(sessionId: string): Promise<CaptainSessionSnapshot | undefined> {
    const entries = (await this.store.readAll()).filter(
      (entry) => entry.event.missionId === this.missionId && entry.event.data.sessionId === sessionId,
    );
    if (entries.length === 0) return undefined;
    return entries.reduce<CaptainSessionSnapshot>((snapshot, entry) => this.reduce(snapshot, entry), {
      projectId: this.projectId,
      sessionId,
      state: "active",
      usage: ZERO_TOKEN_USAGE,
      lastInputTokens: 0,
      compactions: { requested: 0, completed: 0 },
    });
  }

  public verify(): Promise<ChainVerification> {
    return this.store.verify();
  }

  public close(): void {
    this.closeStore?.();
  }

  private get missionId(): string {
    return `captain-project:${this.projectId}`;
  }

  private record(event: LedgerEvent): Promise<StoredEvent> {
    return this.store.append({
      id: eventId(this.projectId, event),
      occurredAt: event.occurredAt,
      missionId: this.missionId,
      correlationId: event.sessionId,
      ...(event.turnId === undefined ? {} : { causationId: event.turnId }),
      profileHash: LEDGER_PROFILE_HASH,
      type: event.type,
      data: {
        schemaVersion: 1,
        projectId: this.projectId,
        sessionId: event.sessionId,
        eventKey: event.eventKey,
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        ...event.data,
      },
    });
  }

  private reduce(snapshot: CaptainSessionSnapshot, entry: StoredEvent): CaptainSessionSnapshot {
    const data = entry.event.data;
    const turnId = stringValue(data.turnId) ?? snapshot.lastTurnId;
    const common = {
      ...snapshot,
      ...(turnId === undefined ? {} : { lastTurnId: turnId }),
      updatedAt: entry.event.occurredAt,
    };
    switch (entry.event.type) {
      case "captain.session.started":
      case "captain.session.turn_started":
        return { ...common, state: "active" };
      case "captain.session.model_selected": {
        const modelRef = stringValue(data.modelRef);
        const budget = budgetValue(data.budget);
        return {
          ...common,
          ...(modelRef === undefined ? {} : { modelRef }),
          ...(budget === undefined ? {} : { budget }),
        };
      }
      case "captain.session.usage_recorded": {
        const usage = normalizeTokenUsage(data.usage);
        return {
          ...common,
          usage: addTokenUsage(snapshot.usage, usage),
          lastInputTokens: usage.input,
        };
      }
      case "captain.session.compaction_requested":
        return {
          ...common,
          compactions: {
            ...snapshot.compactions,
            requested: snapshot.compactions.requested + 1,
          },
        };
      case "captain.session.compaction_completed":
        return {
          ...common,
          compactions: {
            ...snapshot.compactions,
            completed: snapshot.compactions.completed + 1,
          },
        };
      case "captain.session.waiting":
        return { ...common, state: "waiting" };
      case "captain.session.completed":
        return { ...common, state: "completed" };
      case "captain.session.failed":
        return { ...common, state: "failed" };
      default:
        return common;
    }
  }
}

export async function openCaptainSessionLedger(
  projectId: string,
  path: string,
): Promise<CaptainSessionLedger> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const store = new SqliteEventStore(path);
  await chmod(path, 0o600);
  return new CaptainSessionLedger(projectId, store, () => store.close());
}
