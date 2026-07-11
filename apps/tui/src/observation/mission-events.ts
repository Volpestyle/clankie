import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

export interface ObservedMissionEvent {
  readonly id: string;
  readonly occurredAt: string;
  readonly missionId: string;
  readonly taskId?: string;
  readonly workerRunId?: string;
  readonly correlationId: string;
  readonly profileHash: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
}

export interface SequencedMissionEvent {
  readonly sequence: number;
  readonly event: ObservedMissionEvent;
}

export interface MissionEventBatch {
  readonly throughSequence: number;
  readonly events: readonly SequencedMissionEvent[];
}

export interface MissionEventSource {
  readonly identity: string;
  readAfter(sequence: number): Promise<MissionEventBatch>;
}

interface EventRow {
  readonly sequence: number;
  readonly event: string;
}

interface HorizonRow {
  readonly through_sequence: number | null;
}

/**
 * Read-only local observation adapter for the control plane's durable event
 * log. A fresh connection per replay keeps console restarts independent from
 * the control-plane writer and notices database replacement.
 */
export class SqliteMissionEventSource implements MissionEventSource {
  public readonly identity: string;
  private readonly path: string;

  public constructor(path: string) {
    this.path = resolve(path);
    this.identity = `sqlite:${this.path}`;
  }

  public readAfter(sequence: number): Promise<MissionEventBatch> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      return Promise.reject(new Error("Mission event cursor must be a non-negative safe integer"));
    }
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(this.path, { readOnly: true, timeout: 250 });
      database.exec("PRAGMA query_only = ON");
      const horizon = database
        .prepare("SELECT MAX(sequence) AS through_sequence FROM events")
        .get() as unknown as HorizonRow;
      const rows = database
        .prepare("SELECT sequence, event FROM events WHERE sequence > ? ORDER BY sequence")
        .all(sequence) as unknown as EventRow[];
      return Promise.resolve({
        throughSequence: horizon.through_sequence ?? 0,
        events: rows.map((row) => ({
          sequence: row.sequence,
          event: parseObservedMissionEvent(JSON.parse(row.event) as unknown),
        })),
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      database?.close();
    }
  }
}

function stringField(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Mission event ${name} must be a non-empty string`);
  }
  return value;
}

function optionalStringField(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Mission event ${name} must be a non-empty string when present`);
  }
  return value;
}

export function parseObservedMissionEvent(value: unknown): ObservedMissionEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Mission event must be an object");
  }
  const record = value as Record<string, unknown>;
  const data = record.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Mission event data must be an object");
  }
  const taskId = optionalStringField(record, "taskId");
  const workerRunId = optionalStringField(record, "workerRunId");
  return {
    id: stringField(record, "id"),
    occurredAt: stringField(record, "occurredAt"),
    missionId: stringField(record, "missionId"),
    ...(taskId === undefined ? {} : { taskId }),
    ...(workerRunId === undefined ? {} : { workerRunId }),
    correlationId: stringField(record, "correlationId"),
    profileHash: stringField(record, "profileHash"),
    type: stringField(record, "type"),
    data: data as Record<string, unknown>,
  };
}
