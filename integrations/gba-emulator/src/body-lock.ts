import { openSync, closeSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/**
 * One writer for the emulator body, across processes.
 *
 * `EnvironmentRuntime` already refuses a second writer — but only one it can
 * see, and each entrypoint constructs its own runtime in its own process. The
 * free-play CLI, the live activity run, and the MCP server are three separate
 * processes, so the in-memory rule never fired between them: two of them could
 * drive the same game at once, each believing it held the body. That is the
 * footgun [ADR 0053](../../../docs/adr/0053-mcp-possession-of-clankies-body.md)
 * recorded as documented-but-unenforced.
 *
 * A lockfile in the shared body root is the smallest thing that actually
 * enforces it. It is deliberately *not* a general-purpose lease: it grants no
 * authority, carries no capabilities, and expires by liveness rather than time.
 * The runtime's lease still governs what the holder may do; this only decides
 * who gets to be the holder.
 *
 * A crashed holder must not brick the body, so a lock whose owning process is
 * gone is reclaimed rather than honoured. That check is `kill(pid, 0)`, which
 * is why the lock is only meaningful on one machine — the body is local
 * hardware, so that is the same boundary the emulator itself has.
 */
export const BODY_LOCK_FILENAME = "body.lock";

const BodyLockHolderSchema = z.object({
  pid: z.number().int().positive(),
  holderId: z.string().min(1).max(200),
  acquiredAt: z.string().min(1),
});

export type BodyLockHolder = z.infer<typeof BodyLockHolderSchema>;

export class BodyBusyError extends Error {
  readonly holder: BodyLockHolder;

  constructor(holder: BodyLockHolder) {
    super(
      `Clankie's body is already held by ${holder.holderId} (pid ${String(holder.pid)}, since ${holder.acquiredAt}). ` +
        `Stop that process, or set CLANKIE_GBA_BODY_ROOT to drive a separate body.`,
    );
    this.name = "BodyBusyError";
    this.holder = holder;
  }
}

export interface BodyLock {
  readonly holder: BodyLockHolder;
  readonly lockPath: string;
  release(): void;
}

export interface AcquireBodyLockOptions {
  rootDir: string;
  holderId: string;
  pid?: number;
  now?: () => Date;
  /** Injected so the reclaim path is testable without spawning processes. */
  isAlive?: (pid: number) => boolean;
}

export function acquireBodyLock(options: AcquireBodyLockOptions): BodyLock {
  const lockPath = path.join(options.rootDir, BODY_LOCK_FILENAME);
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  const isAlive = options.isAlive ?? defaultIsAlive;

  const holder: BodyLockHolder = {
    pid,
    holderId: options.holderId,
    acquiredAt: now().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // "wx" fails if the path exists, and that failure is the mutual
      // exclusion — checking first and then writing would race.
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, JSON.stringify(holder));
      } finally {
        closeSync(fd);
      }
      return { holder, lockPath, release: () => releaseIfOurs(lockPath, holder) };
    } catch (error) {
      if (!isExistsError(error)) throw error;

      const existing = readHolder(lockPath);
      if (existing === null) {
        // Unparseable or vanished: treat as stale and retry once. A corrupt
        // lock must not be permanently fatal.
        try {
          unlinkSync(lockPath);
        } catch {
          // Someone else reclaimed it first; the retry will contend normally.
        }
        continue;
      }

      if (isAlive(existing.pid)) throw new BodyBusyError(existing);

      // Holder died without releasing. Reclaim.
      try {
        unlinkSync(lockPath);
      } catch {
        // Lost the reclaim race; the retry will observe the new holder.
      }
    }
  }

  const existing = readHolder(lockPath);
  throw existing === null
    ? new Error(`Could not acquire Clankie's body lock at ${lockPath}`)
    : new BodyBusyError(existing);
}

function releaseIfOurs(lockPath: string, holder: BodyLockHolder): void {
  // Only remove a lock we still own: if ours was reclaimed as stale and another
  // process now holds it, deleting the file would silently unlock theirs.
  const current = readHolder(lockPath);
  if (current === null) return;
  if (current.pid !== holder.pid || current.acquiredAt !== holder.acquiredAt) return;
  try {
    unlinkSync(lockPath);
  } catch {
    // Already gone.
  }
}

function readHolder(lockPath: string): BodyLockHolder | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
    const result = BodyLockHolderSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without delivering.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user — still alive.
    return isPermissionError(error);
  }
}

function isExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EEXIST";
}

function isPermissionError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "EPERM";
}
