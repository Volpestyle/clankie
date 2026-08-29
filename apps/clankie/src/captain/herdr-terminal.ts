import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  OPERATOR_TERMINAL_FRAME_BASE64_MAX,
  OperatorTerminalFrameSchema,
  type OperatorTerminalFrame,
  type OperatorTerminalObservationRequest,
  type OperatorTerminalObservationResult,
  type OperatorTerminalObservationUnavailable,
} from "@clankie/protocol";
import { z } from "zod";

const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 40;
const DEFAULT_LIMIT = 32;
const DEFAULT_WAIT_MS = 250;
const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_MAX_FRAMES = 256;

type UnavailableReason = OperatorTerminalObservationUnavailable["reason"];

const HerdrTerminalLineSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("terminal.frame"),
      seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      encoding: z.literal("ansi"),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      full: z.boolean(),
      bytes: z.string(),
    })
    .strict(),
  z.object({ type: z.literal("terminal.closed"), reason: z.string().nullable() }).strict(),
]);

export interface HerdrTerminalObserver {
  readonly lines: AsyncIterable<string>;
  readonly done: Promise<UnavailableReason>;
  close(): void;
}

export type StartHerdrTerminalObserver = (
  terminalId: string,
  columns: number,
  rows: number,
) => HerdrTerminalObserver;

/**
 * Bounded per-native-surface terminal observers. Herdr owns VT rendering; this
 * store only retains enough sequenced ANSI frames to bridge relay tail polls.
 */
export class HerdrTerminalStore {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly startObserver: StartHerdrTerminalObserver;
  private readonly waitMs: number;
  private readonly idleMs: number;
  private readonly maxSessions: number;
  private readonly maxFrames: number;

  public constructor(
    options: {
      readonly startObserver?: StartHerdrTerminalObserver;
      readonly waitMs?: number;
      readonly idleMs?: number;
      readonly maxSessions?: number;
      readonly maxFrames?: number;
    } = {},
  ) {
    this.startObserver = options.startObserver ?? startHerdrTerminalObserver;
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
  }

  public async tail(request: OperatorTerminalObservationRequest): Promise<OperatorTerminalObservationResult> {
    const key = sessionKey(request);
    const columns = request.columns ?? DEFAULT_COLUMNS;
    const rows = request.rows ?? DEFAULT_ROWS;
    let session = this.sessions.get(key);

    if (request.cursor === undefined) {
      session?.close();
      this.sessions.delete(key);
      this.admit();
      try {
        session = new TerminalSession({
          terminalId: request.terminalId,
          surfaceClientId: request.surfaceClientId,
          columns,
          rows,
          observer: this.startObserver(request.terminalId, columns, rows),
          idleMs: this.idleMs,
          maxFrames: this.maxFrames,
          onIdle: () => {
            if (this.sessions.get(key) === session) this.sessions.delete(key);
          },
        });
      } catch {
        return unavailable(request, "herdr_unavailable");
      }
      this.sessions.set(key, session);
    } else if (
      session === undefined ||
      session.streamId !== request.cursor.streamId ||
      session.columns !== columns ||
      session.rows !== rows
    ) {
      return {
        schemaVersion: 1,
        status: "reset",
        terminalId: request.terminalId,
        surfaceClientId: request.surfaceClientId,
        reason: "stream_lost",
      };
    }

    session.touch();
    return session.read(request.cursor?.sequence ?? 0, request.limit ?? DEFAULT_LIMIT, this.waitMs);
  }

  public close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private admit(): void {
    if (this.sessions.size < this.maxSessions) return;
    // ponytail: one observer per native surface; share observers only if 64
    // concurrent terminal surfaces becomes a measured product requirement.
    const oldest = [...this.sessions.entries()].sort(
      (left, right) => left[1].touchedAt - right[1].touchedAt,
    )[0];
    if (oldest === undefined) return;
    oldest[1].close();
    this.sessions.delete(oldest[0]);
  }
}

class TerminalSession {
  public readonly streamId = randomUUID();
  public readonly columns: number;
  public readonly rows: number;
  public touchedAt = Date.now();

  private readonly terminalId: string;
  private readonly surfaceClientId: string;
  private readonly observer: HerdrTerminalObserver;
  private readonly idleMs: number;
  private readonly maxFrames: number;
  private readonly onIdle: () => void;
  private readonly frames: OperatorTerminalFrame[] = [];
  private readonly listeners = new Set<() => void>();
  private retainedBytes = 0;
  private lastSequence = 0;
  private ended: UnavailableReason | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(options: {
    readonly terminalId: string;
    readonly surfaceClientId: string;
    readonly columns: number;
    readonly rows: number;
    readonly observer: HerdrTerminalObserver;
    readonly idleMs: number;
    readonly maxFrames: number;
    readonly onIdle: () => void;
  }) {
    this.terminalId = options.terminalId;
    this.surfaceClientId = options.surfaceClientId;
    this.columns = options.columns;
    this.rows = options.rows;
    this.observer = options.observer;
    this.idleMs = options.idleMs;
    this.maxFrames = options.maxFrames;
    this.onIdle = options.onIdle;
    void this.consume();
  }

  public touch(): void {
    this.touchedAt = Date.now();
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.close();
      this.onIdle();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  public async read(
    afterSequence: number,
    limit: number,
    waitMs: number,
  ): Promise<OperatorTerminalObservationResult> {
    const immediate = this.page(afterSequence, limit);
    if (immediate !== undefined) return immediate;
    if (this.ended !== undefined) return this.unavailable(this.ended);
    await this.wait(waitMs);
    return this.page(afterSequence, limit) ?? this.unavailable(this.ended ?? "observer_closed", true);
  }

  public close(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.observer.close();
    this.finish("observer_closed");
  }

  private async consume(): Promise<void> {
    try {
      for await (const line of this.observer.lines) {
        if (line.length > OPERATOR_TERMINAL_FRAME_BASE64_MAX + 4_096) {
          this.finish("invalid_frame");
          return;
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(line) as unknown;
        } catch {
          this.finish("invalid_frame");
          return;
        }
        const parsed = HerdrTerminalLineSchema.safeParse(decoded);
        if (!parsed.success) {
          this.finish("invalid_frame");
          return;
        }
        if (parsed.data.type === "terminal.closed") {
          this.finish("terminal_unavailable");
          return;
        }
        const frame = OperatorTerminalFrameSchema.safeParse({
          schemaVersion: 1,
          type: "terminal.frame",
          terminalId: this.terminalId,
          sequence: parsed.data.seq,
          encoding: "base64",
          data: parsed.data.bytes,
          columns: parsed.data.width,
          rows: parsed.data.height,
          full: parsed.data.full,
        });
        if (
          !frame.success ||
          frame.data.sequence !== this.lastSequence + 1 ||
          (this.lastSequence === 0 && !frame.data.full)
        ) {
          this.finish("invalid_frame");
          return;
        }
        this.frames.push(frame.data);
        this.lastSequence = frame.data.sequence;
        this.retainedBytes += frame.data.data.length;
        while (
          this.frames.length > this.maxFrames ||
          (this.retainedBytes > OPERATOR_TERMINAL_FRAME_BASE64_MAX && this.frames.length > 1)
        ) {
          const removed = this.frames.shift();
          if (removed !== undefined) this.retainedBytes -= removed.data.length;
        }
        this.wake();
      }
      this.finish(await this.observer.done);
    } catch {
      this.finish("herdr_unavailable");
    } finally {
      this.observer.close();
    }
  }

  private page(afterSequence: number, limit: number): OperatorTerminalObservationResult | undefined {
    if (afterSequence > this.lastSequence) return this.reset("stream_lost");
    const firstSequence = this.frames[0]?.sequence;
    if (firstSequence !== undefined && afterSequence < firstSequence - 1) {
      return this.reset("sequence_expired");
    }

    const frames: OperatorTerminalFrame[] = [];
    let bytes = 0;
    for (const frame of this.frames) {
      if (frame.sequence <= afterSequence) continue;
      if (frames.length >= limit || bytes + frame.data.length > OPERATOR_TERMINAL_FRAME_BASE64_MAX) break;
      frames.push(frame);
      bytes += frame.data.length;
    }
    if (frames.length === 0) return undefined;
    const sequence = frames.at(-1)?.sequence ?? afterSequence;
    return {
      schemaVersion: 1,
      status: "page",
      terminalId: this.terminalId,
      surfaceClientId: this.surfaceClientId,
      cursor: { streamId: this.streamId, sequence },
      frames,
      hasMore: this.frames.some((frame) => frame.sequence > sequence),
    };
  }

  private reset(reason: "stream_lost" | "sequence_expired"): OperatorTerminalObservationResult {
    return {
      schemaVersion: 1,
      status: "reset",
      terminalId: this.terminalId,
      surfaceClientId: this.surfaceClientId,
      reason,
    };
  }

  private unavailable(reason: UnavailableReason, emptyPage = false): OperatorTerminalObservationResult {
    if (emptyPage && this.ended === undefined) {
      return {
        schemaVersion: 1,
        status: "page",
        terminalId: this.terminalId,
        surfaceClientId: this.surfaceClientId,
        cursor: { streamId: this.streamId, sequence: this.lastSequence },
        frames: [],
        hasMore: false,
      };
    }
    return {
      schemaVersion: 1,
      status: "unavailable",
      terminalId: this.terminalId,
      surfaceClientId: this.surfaceClientId,
      reason,
    };
  }

  private finish(reason: UnavailableReason): void {
    if (this.ended !== undefined) return;
    this.ended = reason;
    this.wake();
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.listeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.listeners.add(done);
    });
  }

  private wake(): void {
    for (const listener of this.listeners) listener();
  }
}

function startHerdrTerminalObserver(
  terminalId: string,
  columns: number,
  rows: number,
): HerdrTerminalObserver {
  const child = spawn(
    "herdr",
    ["terminal", "session", "observe", terminalId, "--cols", String(columns), "--rows", String(rows)],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const done = new Promise<UnavailableReason>((resolve) => {
    child.once("error", () => resolve("herdr_unavailable"));
    child.once("close", (code) => resolve(code === 0 ? "observer_closed" : "herdr_unavailable"));
  });
  return {
    lines,
    done,
    close: () => {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

function sessionKey(request: OperatorTerminalObservationRequest): string {
  return JSON.stringify([request.surfaceClientId, request.terminalId]);
}

function unavailable(
  request: OperatorTerminalObservationRequest,
  reason: UnavailableReason,
): OperatorTerminalObservationUnavailable {
  return {
    schemaVersion: 1,
    status: "unavailable",
    terminalId: request.terminalId,
    surfaceClientId: request.surfaceClientId,
    reason,
  };
}
