import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import {
  OPERATOR_TERMINAL_FRAME_BASE64_MAX,
  OperatorTerminalFrameSchema,
  type OperatorTerminalFrame,
  type OperatorTerminalObservationRequest,
  type OperatorTerminalObservationResult,
  type OperatorTerminalObservationUnavailable,
} from "@clankie/protocol";
import { z } from "zod";
import { readTerminalGrid, type HerdrPaneGrid } from "./herdr-census.ts";

const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 40;
const DEFAULT_LIMIT = 32;
const DEFAULT_WAIT_MS = 250;
const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_MAX_FRAMES = 256;
const HISTORY_LINES = 1_000;
const HERDR_READ_TIMEOUT_MS = 5_000;
const SCROLLBACK_QUIET_MS = 150;
const SCROLLBACK_MAX_LATENCY_MS = 1_000;

const execFileAsync = promisify(execFile);

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

export type ReadHerdrTerminalGrid = (terminalId: string) => Promise<HerdrPaneGrid | undefined>;
export type ReadControlledTerminalGrid = (
  terminalId: string,
  surfaceClientId: string,
) => HerdrPaneGrid | undefined;
export type ReadHerdrTerminalHistory = (paneId: string) => Promise<string | undefined>;

/**
 * Bounded per-native-surface terminal observers. Herdr owns VT rendering; this
 * store only retains enough sequenced ANSI frames to bridge relay tail polls.
 */
export class HerdrTerminalStore {
  private readonly sessions = new Map<string, TerminalSession>();
  private readonly startObserver: StartHerdrTerminalObserver;
  private readonly readGrid: ReadHerdrTerminalGrid;
  private readonly readControlledGrid: ReadControlledTerminalGrid;
  private readonly readHistory: ReadHerdrTerminalHistory;
  private readonly scrollbackQuietMs: number;
  private readonly scrollbackMaxLatencyMs: number;
  private readonly waitMs: number;
  private readonly idleMs: number;
  private readonly maxSessions: number;
  private readonly maxFrames: number;

  public constructor(
    options: {
      readonly startObserver?: StartHerdrTerminalObserver;
      readonly readGrid?: ReadHerdrTerminalGrid;
      readonly readControlledGrid?: ReadControlledTerminalGrid;
      readonly readHistory?: ReadHerdrTerminalHistory;
      readonly scrollbackQuietMs?: number;
      readonly scrollbackMaxLatencyMs?: number;
      readonly waitMs?: number;
      readonly idleMs?: number;
      readonly maxSessions?: number;
      readonly maxFrames?: number;
    } = {},
  ) {
    this.startObserver = options.startObserver ?? startHerdrTerminalObserver;
    this.readGrid = options.readGrid ?? ((terminalId) => readTerminalGrid(terminalId));
    this.readControlledGrid = options.readControlledGrid ?? (() => undefined);
    this.readHistory = options.readHistory ?? readHerdrTerminalHistory;
    this.scrollbackQuietMs = options.scrollbackQuietMs ?? SCROLLBACK_QUIET_MS;
    this.scrollbackMaxLatencyMs = options.scrollbackMaxLatencyMs ?? SCROLLBACK_MAX_LATENCY_MS;
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxFrames = options.maxFrames ?? DEFAULT_MAX_FRAMES;
  }

  public async tail(request: OperatorTerminalObservationRequest): Promise<OperatorTerminalObservationResult> {
    const key = sessionKey(request);
    let session = this.sessions.get(key);

    if (request.cursor === undefined) {
      // Observe at the pane's own grid, not the surface's viewport. Herdr renders
      // a pane cropped into whatever area an observer asks for, so asking for a
      // phone's width truncates every line the pane wrapped at its real width.
      // The surface fits the frame it is handed instead (see the frame's own
      // columns/rows). Falls back to the surface's request when Herdr cannot
      // report the grid.
      const grid =
        this.readControlledGrid(request.terminalId, request.surfaceClientId) ??
        (await this.readGrid(request.terminalId));
      const columns = grid?.columns ?? request.columns ?? DEFAULT_COLUMNS;
      const rows = grid?.rows ?? request.rows ?? DEFAULT_ROWS;
      const history = grid?.paneId === undefined ? undefined : await this.readHistory(grid.paneId);
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
          ...(history === undefined ? {} : { history }),
          ...(grid?.paneId === undefined
            ? {}
            : {
                paneId: grid.paneId,
                readHistory: this.readHistory,
                scrollbackQuietMs: this.scrollbackQuietMs,
                scrollbackMaxLatencyMs: this.scrollbackMaxLatencyMs,
              }),
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
      // A surface resize no longer invalidates the stream: the frame geometry is
      // the pane's, and the surface refits it. The stream does go stale if the
      // pane itself is resized mid-observation; it heals on the next reconnect.
    } else if (session === undefined || session.streamId !== request.cursor.streamId) {
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
  private readonly paneId: string | undefined;
  private readonly readHistory: ReadHerdrTerminalHistory | undefined;
  private readonly scrollbackQuietMs: number;
  private readonly scrollbackMaxLatencyMs: number;
  private history: string | undefined;
  private historyRows: string[];
  private readonly idleMs: number;
  private readonly maxFrames: number;
  private readonly onIdle: () => void;
  private readonly frames: OperatorTerminalFrame[] = [];
  private readonly listeners = new Set<() => void>();
  private retainedBytes = 0;
  private lastObserverSequence = 0;
  private lastSequence = 0;
  private ended: UnavailableReason | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private scrollbackTimer: ReturnType<typeof setTimeout> | undefined;
  private scrollbackDirtySince: number | undefined;
  private refreshingScrollback = false;

  public constructor(options: {
    readonly terminalId: string;
    readonly surfaceClientId: string;
    readonly columns: number;
    readonly rows: number;
    readonly observer: HerdrTerminalObserver;
    readonly history?: string;
    readonly paneId?: string;
    readonly readHistory?: ReadHerdrTerminalHistory;
    readonly scrollbackQuietMs?: number;
    readonly scrollbackMaxLatencyMs?: number;
    readonly idleMs: number;
    readonly maxFrames: number;
    readonly onIdle: () => void;
  }) {
    this.terminalId = options.terminalId;
    this.surfaceClientId = options.surfaceClientId;
    this.columns = options.columns;
    this.rows = options.rows;
    this.observer = options.observer;
    this.history = options.history;
    this.historyRows = historyRows(options.history, options.rows);
    this.paneId = options.paneId;
    this.readHistory = options.readHistory;
    this.scrollbackQuietMs = options.scrollbackQuietMs ?? SCROLLBACK_QUIET_MS;
    this.scrollbackMaxLatencyMs = options.scrollbackMaxLatencyMs ?? SCROLLBACK_MAX_LATENCY_MS;
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
    if (this.scrollbackTimer !== undefined) clearTimeout(this.scrollbackTimer);
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
          sequence: this.lastSequence + 1,
          encoding: "base64",
          data: parsed.data.bytes,
          columns: parsed.data.width,
          rows: parsed.data.height,
          full: parsed.data.full,
        });
        if (
          !frame.success ||
          parsed.data.seq !== this.lastObserverSequence + 1 ||
          (this.lastObserverSequence === 0 && !frame.data.full)
        ) {
          this.finish("invalid_frame");
          return;
        }
        let accepted = frame.data;
        if (this.lastObserverSequence === 0 && this.history !== undefined) {
          const seeded = OperatorTerminalFrameSchema.safeParse({
            ...frame.data,
            data: Buffer.concat([Buffer.from(this.history), Buffer.from(frame.data.data, "base64")]).toString(
              "base64",
            ),
          });
          if (seeded.success) accepted = seeded.data;
          this.history = undefined;
        }
        this.lastObserverSequence = parsed.data.seq;
        this.appendFrame(accepted);
        this.scheduleScrollbackRefresh();
      }
      this.finish(await this.observer.done);
    } catch {
      this.finish("herdr_unavailable");
    } finally {
      this.observer.close();
    }
  }

  private scheduleScrollbackRefresh(): void {
    if (this.paneId === undefined || this.readHistory === undefined || this.ended !== undefined) return;
    const now = Date.now();
    this.scrollbackDirtySince ??= now;
    if (this.scrollbackTimer !== undefined) clearTimeout(this.scrollbackTimer);
    const maxDelay = Math.max(0, this.scrollbackMaxLatencyMs - (now - this.scrollbackDirtySince));
    this.scrollbackTimer = setTimeout(
      () => {
        this.scrollbackTimer = undefined;
        void this.refreshScrollback();
      },
      Math.min(this.scrollbackQuietMs, maxDelay),
    );
    this.scrollbackTimer.unref?.();
  }

  private async refreshScrollback(): Promise<void> {
    if (this.refreshingScrollback) return;
    const paneId = this.paneId;
    const read = this.readHistory;
    if (paneId === undefined || read === undefined) return;
    this.refreshingScrollback = true;
    this.scrollbackDirtySince = undefined;
    try {
      const snapshot = await read(paneId);
      if (snapshot === undefined) return;
      const next = historyRows(snapshot, this.rows);
      const overlap = suffixPrefixOverlap(this.historyRows, next);
      const appended = next.slice(overlap);
      if (this.historyRows.length > 0 && overlap === 0) {
        this.appendSyntheticFrame(Buffer.from("\u001b[3J").toString("base64"));
      }
      if (appended.length > 0) {
        this.appendSyntheticFrame("", {
          encoding: "base64",
          data: Buffer.from(`${appended.join("\r\n")}\r\n`).toString("base64"),
          rows: appended.length,
        });
      }
      this.historyRows = next;
    } finally {
      this.refreshingScrollback = false;
      if (this.scrollbackDirtySince !== undefined) this.scheduleScrollbackRefresh();
    }
  }

  private appendSyntheticFrame(
    data: string,
    scrollback?: { readonly encoding: "base64"; readonly data: string; readonly rows: number },
  ): void {
    if (this.ended !== undefined) return;
    const parsed = OperatorTerminalFrameSchema.safeParse({
      schemaVersion: 1,
      type: "terminal.frame",
      terminalId: this.terminalId,
      sequence: this.lastSequence + 1,
      encoding: "base64",
      data,
      columns: this.columns,
      rows: this.rows,
      full: false,
      ...(scrollback === undefined ? {} : { scrollback }),
    });
    if (parsed.success) this.appendFrame(parsed.data);
  }

  private appendFrame(frame: OperatorTerminalFrame): void {
    this.frames.push(frame);
    this.lastSequence = frame.sequence;
    this.retainedBytes += frame.data.length + (frame.scrollback?.data.length ?? 0);
    while (
      this.frames.length > this.maxFrames ||
      (this.retainedBytes > OPERATOR_TERMINAL_FRAME_BASE64_MAX && this.frames.length > 1)
    ) {
      const removed = this.frames.shift();
      if (removed !== undefined) {
        this.retainedBytes -= removed.data.length + (removed.scrollback?.data.length ?? 0);
      }
    }
    this.wake();
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
      const frameBytes = frame.data.length + (frame.scrollback?.data.length ?? 0);
      if (frames.length >= limit || bytes + frameBytes > OPERATOR_TERMINAL_FRAME_BASE64_MAX) break;
      frames.push(frame);
      bytes += frameBytes;
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
    if (this.scrollbackTimer !== undefined) clearTimeout(this.scrollbackTimer);
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

async function readHerdrTerminalHistory(paneId: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "herdr",
      ["pane", "read", paneId, "--source", "recent", "--lines", String(HISTORY_LINES), "--raw"],
      { timeout: HERDR_READ_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    return String(stdout);
  } catch {
    return undefined;
  }
}

function historyRows(snapshot: string | undefined, viewportRows: number): string[] {
  if (snapshot === undefined) return [];
  const rendered = snapshot.split(/\r\n|\n|\r/u);
  if (rendered.at(-1) === "") rendered.pop();
  return rendered.slice(0, Math.max(0, rendered.length - viewportRows));
}

function suffixPrefixOverlap(previous: readonly string[], next: readonly string[]): number {
  // ponytail: quadratic scan is bounded by vanilla Herdr's 1,000-row read;
  // replace with KMP only if profiles show this quiet-path comparison matters.
  const maximum = Math.min(previous.length, next.length);
  for (let length = maximum; length > 0; length -= 1) {
    let matches = true;
    for (let index = 0; index < length; index += 1) {
      if (previous[previous.length - length + index] !== next[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
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
