import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionState } from "eve/client";

export interface CaptainSessionCursor extends SessionState {
  readonly version: 2;
  readonly active: boolean;
  readonly generation: string;
}

export interface LegacyCaptainSessionCursor extends SessionState {
  readonly version: 1;
  readonly active: boolean;
}

export type StoredCaptainSessionCursor = CaptainSessionCursor | LegacyCaptainSessionCursor;

function parseCursor(value: unknown): StoredCaptainSessionCursor | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if ((record.version !== 1 && record.version !== 2) || typeof record.active !== "boolean") {
    return undefined;
  }
  if (
    record.version === 2 &&
    (typeof record.generation !== "string" || !/^[a-f0-9]{64}$/u.test(record.generation))
  ) {
    return undefined;
  }
  if (!Number.isSafeInteger(record.streamIndex) || (record.streamIndex as number) < 0) return undefined;
  if (
    record.sessionId !== undefined &&
    (typeof record.sessionId !== "string" || record.sessionId.length === 0)
  )
    return undefined;
  if (
    record.continuationToken !== undefined &&
    (typeof record.continuationToken !== "string" || record.continuationToken.length === 0)
  )
    return undefined;
  if (record.active === true && record.sessionId === undefined) return undefined;
  if (record.sessionId === undefined && record.continuationToken !== undefined) return undefined;
  if (record.sessionId === undefined && record.streamIndex !== 0) return undefined;
  const state = {
    active: record.active,
    streamIndex: record.streamIndex as number,
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId as string }),
    ...(record.continuationToken === undefined
      ? {}
      : { continuationToken: record.continuationToken as string }),
  };
  return record.version === 2
    ? { ...state, version: 2, generation: record.generation as string }
    : { ...state, version: 1 };
}

export class CaptainSessionCursorStore {
  private readonly path: string;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(path: string) {
    this.path = path;
  }

  public async read(): Promise<StoredCaptainSessionCursor | undefined> {
    try {
      const parsed = parseCursor(JSON.parse(await readFile(this.path, "utf8")));
      if (parsed === undefined) {
        throw new Error(`Captain session cursor ${this.path} has an invalid schema`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(
        `Cannot safely resume the captain session from ${this.path}; refusing to start a new session`,
        { cause: error },
      );
    }
  }

  public write(cursor: CaptainSessionCursor): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const parent = dirname(this.path);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await chmod(parent, 0o700);
      const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(cursor)}\n`, { encoding: "utf8", mode: 0o600 });
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

export function emptyCaptainCursor(generation: string): CaptainSessionCursor {
  return { version: 2, active: false, generation, streamIndex: 0 };
}
