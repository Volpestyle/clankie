import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isTraceLane, type TraceCursor, type TraceLane } from "./trace-types.ts";

function parseTraceCursor(value: unknown): TraceCursor | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.active !== "boolean") return undefined;
  if (typeof record.generation !== "string" || !/^[a-f0-9]{64}$/u.test(record.generation)) {
    return undefined;
  }
  if (!Number.isSafeInteger(record.streamIndex) || (record.streamIndex as number) < 0) return undefined;
  if (!isTraceLane(record.lane)) return undefined;
  if (
    record.sessionId !== undefined &&
    (typeof record.sessionId !== "string" || record.sessionId.length === 0)
  ) {
    return undefined;
  }
  if (record.active === true && record.sessionId === undefined) return undefined;
  return {
    version: 1,
    generation: record.generation,
    streamIndex: record.streamIndex as number,
    lane: record.lane,
    active: record.active,
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId as string }),
  };
}

/** Mode-0600 identity-only checkpoint store for `clankie trace`. Never writes payloads. */
export class TraceCursorStore {
  private readonly path: string;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(path: string) {
    this.path = path;
  }

  public async read(): Promise<TraceCursor | undefined> {
    try {
      const parsed = parseTraceCursor(JSON.parse(await readFile(this.path, "utf8")));
      if (parsed === undefined) {
        throw new Error(`Trace cursor ${this.path} has an invalid schema`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(`Cannot safely resume the trace cursor from ${this.path}`, { cause: error });
    }
  }

  public write(cursor: TraceCursor): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const parent = dirname(this.path);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await chmod(parent, 0o700);
      const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
      // Identity fields only — never event payloads, reasoning, or tool I/O.
      const identity: TraceCursor = {
        version: 1,
        generation: cursor.generation,
        streamIndex: cursor.streamIndex,
        lane: cursor.lane,
        active: cursor.active,
        ...(cursor.sessionId === undefined ? {} : { sessionId: cursor.sessionId }),
      };
      await writeFile(temporary, `${JSON.stringify(identity)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  public clear(): Promise<void> {
    const operation = this.writeQueue.then(() => rm(this.path, { force: true }));
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }
}

export function emptyTraceCursor(generation: string, lane: TraceLane): TraceCursor {
  return { version: 1, generation, streamIndex: 0, lane, active: false };
}
