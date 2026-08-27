import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { VoxClientError, type VoxClient, type VoxControlEvent } from "@clankie/vox-client";

/**
 * Shared DJ queue for the active Discord mouth.
 *
 * The model (captain text tools or the voice realtime tools) searches and
 * picks. This module is the sink and the structured control surface — it
 * never parses chat. Vox is the sole media sink for both Discord bodies.
 */

export type VoiceMusicCommand =
  | { readonly kind: "play"; readonly url: string }
  | { readonly kind: "queue"; readonly url: string }
  | { readonly kind: "skip" }
  | { readonly kind: "pause" }
  | { readonly kind: "resume" }
  | { readonly kind: "stop" }
  | { readonly kind: "now" };

export interface VoiceMusicTrack {
  readonly url: string;
  readonly requestedBy?: string;
}

export interface VoiceMusicSnapshot {
  readonly current: VoiceMusicTrack | undefined;
  readonly queued: readonly VoiceMusicTrack[];
  readonly paused: boolean;
  readonly starting: boolean;
  readonly sink: "audio" | "video";
}

/** IDs only: enough to join a music event to the utterance/tool that caused it. */
export interface VoiceMusicTraceContext {
  readonly source: "realtime" | "control";
  readonly deliveryId?: string;
  readonly callId?: string;
}

export type VoiceMusicTraceEvent = VoiceMusicTraceContext & {
  readonly operation: MusicControlAction | "ended" | "duck" | "unduck";
  readonly component: "queue" | "yt_dlp" | "ffmpeg" | "pipeline" | "player";
  readonly outcome:
    | "offered"
    | "empty"
    | "rejected"
    | "started"
    | "queued"
    | "skipped"
    | "paused"
    | "resumed"
    | "stopped"
    | "reported"
    | "ended"
    | "ducked"
    | "unducked"
    | "spawned"
    | "first_audio"
    | "exited"
    | "failed"
    | "submitted"
    | "playing"
    | "idle";
  readonly current?: boolean;
  readonly queuedCount?: number;
  readonly paused?: boolean;
  readonly resultCount?: number;
  readonly exitCode?: number;
  readonly code?: string;
};

export type VoiceMusicTrace = (event: VoiceMusicTraceEvent) => void;

/** Transport-specific play/pause/stop. One track, one sink. */
export interface VoiceMusicSink {
  play(url: string, trace?: VoiceMusicTraceContext): Promise<void> | void;
  pause(): void;
  resume(): void;
  stop(): void;
  duck?(): void;
  unduck?(): void;
  dispose?(): void;
}

interface TrackedVoiceMusicTrack {
  readonly track: VoiceMusicTrack;
  readonly trace?: VoiceMusicTraceContext;
}

const MAX_QUEUE = 32;
const MAX_SEARCH_RESULTS = 5;
const PENDING_PICK_TTL_MS = 120_000;
const SEARCH_TIMEOUT_MS = 15_000;
function musicFailureCode(error: unknown): string {
  return error instanceof VoxClientError ? error.code : "music_sink_rejected";
}

export interface YouTubeSearchHit {
  readonly videoId: string;
  readonly url: string;
  readonly title: string;
  readonly channel?: string;
  readonly duration?: string;
}

const YOUTUBE_HOSTS = new Set(["youtube.com", "youtu.be", "music.youtube.com", "m.youtube.com"]);

export function isAllowedMusicUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    const host = parsed.hostname.replace(/^www\./u, "").toLowerCase();
    return YOUTUBE_HOSTS.has(host);
  } catch {
    return false;
  }
}

export class VoiceMusicQueue {
  private readonly sink: VoiceMusicSink;
  private readonly queued: TrackedVoiceMusicTrack[] = [];
  private current: TrackedVoiceMusicTrack | undefined;
  private paused = false;
  private starting = false;
  private readonly sinkKind: "audio" | "video";
  private readonly searchImpl: typeof searchYouTube;
  private readonly now: () => number;
  private trace: VoiceMusicTrace | undefined;
  private readonly pendingPicks = new Map<
    string,
    { readonly hits: readonly YouTubeSearchHit[]; readonly action: "play" | "queue"; readonly at: number }
  >();

  public constructor(options: {
    readonly sink: VoiceMusicSink;
    readonly sinkKind: "audio" | "video";
    readonly search?: typeof searchYouTube;
    readonly now?: () => number;
    readonly trace?: VoiceMusicTrace;
  }) {
    this.sink = options.sink;
    this.sinkKind = options.sinkKind;
    this.searchImpl = options.search ?? searchYouTube;
    this.now = options.now ?? (() => Date.now());
    this.trace = options.trace;
  }

  public setTrace(trace: VoiceMusicTrace): void {
    this.trace = trace;
  }

  public async searchAndOffer(
    authorId: string,
    query: string,
    action: "play" | "queue",
    trace?: VoiceMusicTraceContext,
  ): Promise<string> {
    const hits = await this.searchImpl(query);
    if (hits.length === 0) {
      this.emit("search", "queue", "empty", trace, { resultCount: 0 });
      return `I couldn't find YouTube results for "${query.slice(0, 80)}".`;
    }
    this.pendingPicks.set(authorId, { hits, action, at: this.now() });
    this.emit("search", "queue", "offered", trace, { resultCount: hits.length });
    const lines = hits.map((hit, index) => {
      const who = hit.channel === undefined ? "" : ` — ${hit.channel}`;
      const length = hit.duration === undefined ? "" : ` (${hit.duration})`;
      return `${String(index + 1)}. ${hit.title}${who}${length}`;
    });
    const verb = action === "queue" ? "queue" : "play";
    return `I found these:\n${lines.join("\n")}\nSay a number to ${verb} it.`;
  }

  public async pick(
    authorId: string,
    index: number,
    action?: "play" | "queue",
    trace?: VoiceMusicTraceContext,
  ): Promise<string> {
    const pending = this.pendingPicks.get(authorId);
    if (pending === undefined || this.now() - pending.at > PENDING_PICK_TTL_MS) {
      this.pendingPicks.delete(authorId);
      this.emit(action ?? "play", "queue", "rejected", trace);
      return "I don't have a search waiting. Ask me to play something first.";
    }
    const hit = pending.hits[index - 1];
    if (hit === undefined) {
      this.emit(action ?? pending.action, "queue", "rejected", trace);
      return `Pick a number from 1 to ${String(pending.hits.length)}.`;
    }
    this.pendingPicks.delete(authorId);
    const resolved = action ?? pending.action;
    return resolved === "queue"
      ? this.enqueue(hit.url, authorId, trace)
      : this.play(hit.url, authorId, trace);
  }

  public snapshot(): VoiceMusicSnapshot {
    return {
      current: this.current?.track,
      queued: this.queued.map((entry) => entry.track),
      paused: this.paused,
      starting: this.starting,
      sink: this.sinkKind,
    };
  }

  public async handle(
    command: VoiceMusicCommand,
    requestedBy?: string,
    trace?: VoiceMusicTraceContext,
  ): Promise<string> {
    switch (command.kind) {
      case "play":
        return this.play(command.url, requestedBy, trace);
      case "queue":
        return this.enqueue(command.url, requestedBy, trace);
      case "skip":
        return this.skip(trace);
      case "pause":
        return this.pause(trace);
      case "resume":
        return this.resume(trace);
      case "stop":
        return this.stop(trace);
      case "now":
        return this.describe(trace);
    }
  }

  public async play(url: string, requestedBy?: string, trace?: VoiceMusicTraceContext): Promise<string> {
    if (!isAllowedMusicUrl(url)) {
      this.emit("play", "queue", "rejected", trace);
      return "I can only play YouTube links.";
    }
    this.queued.length = 0;
    this.paused = false;
    return this.start(
      {
        track: { url, ...(requestedBy === undefined ? {} : { requestedBy }) },
        ...(trace === undefined ? {} : { trace }),
      },
      "play",
    );
  }

  public async enqueue(url: string, requestedBy?: string, trace?: VoiceMusicTraceContext): Promise<string> {
    if (!isAllowedMusicUrl(url)) {
      this.emit("queue", "queue", "rejected", trace);
      return "I can only queue YouTube links.";
    }
    if (this.current === undefined) return this.play(url, requestedBy, trace);
    if (this.queued.length >= MAX_QUEUE) {
      this.emit("queue", "queue", "rejected", trace);
      return "Queue is full.";
    }
    this.queued.push({
      track: { url, ...(requestedBy === undefined ? {} : { requestedBy }) },
      ...(trace === undefined ? {} : { trace }),
    });
    this.emit("queue", "queue", "queued", trace);
    return `Queued (${String(this.queued.length)} waiting).`;
  }

  public async skip(trace?: VoiceMusicTraceContext): Promise<string> {
    if (this.current === undefined) {
      this.emit("skip", "queue", "empty", trace);
      return "Nothing is playing.";
    }
    const next = this.queued.shift();
    this.current = undefined;
    this.paused = false;
    this.starting = false;
    let stopCode: string | undefined;
    try {
      this.sink.stop();
    } catch (error) {
      stopCode = musicFailureCode(error);
    }
    if (next === undefined) {
      this.emit(
        "skip",
        "queue",
        stopCode === undefined ? "skipped" : "failed",
        trace,
        stopCode === undefined ? {} : { code: stopCode },
      );
      return "Skipped. Queue is empty.";
    }
    this.emit(
      "skip",
      "queue",
      stopCode === undefined ? "skipped" : "failed",
      trace,
      stopCode === undefined ? {} : { code: stopCode },
    );
    return this.start(trace === undefined ? next : { track: next.track, trace }, "skip");
  }

  public pause(trace?: VoiceMusicTraceContext): string {
    if (this.current === undefined) {
      this.emit("pause", "queue", "empty", trace);
      return "Nothing is playing.";
    }
    if (this.paused) {
      this.emit("pause", "queue", "paused", trace);
      return "Already paused.";
    }
    try {
      this.sink.pause();
    } catch (error) {
      this.emit("pause", "queue", "failed", trace, { code: musicFailureCode(error) });
      return "I couldn't pause that just now.";
    }
    this.paused = true;
    this.emit("pause", "queue", "paused", trace);
    return "Paused.";
  }

  public resume(trace?: VoiceMusicTraceContext): string {
    if (this.current === undefined) {
      this.emit("resume", "queue", "empty", trace);
      return "Nothing is playing.";
    }
    if (!this.paused) {
      this.emit("resume", "queue", "resumed", trace);
      return "Already playing.";
    }
    try {
      this.sink.resume();
    } catch (error) {
      this.emit("resume", "queue", "failed", trace, { code: musicFailureCode(error) });
      return "I couldn't resume that just now.";
    }
    this.paused = false;
    this.emit("resume", "queue", "resumed", trace);
    return "Resumed.";
  }

  public stop(trace?: VoiceMusicTraceContext): string {
    this.pendingPicks.clear();
    if (this.current === undefined && this.queued.length === 0) {
      this.emit("stop", "queue", "empty", trace);
      return "Nothing is playing.";
    }
    this.current = undefined;
    this.queued.length = 0;
    this.paused = false;
    this.starting = false;
    let stopCode: string | undefined;
    try {
      this.sink.stop();
    } catch (error) {
      stopCode = musicFailureCode(error);
    }
    this.emit(
      "stop",
      "queue",
      stopCode === undefined ? "stopped" : "failed",
      trace,
      stopCode === undefined ? {} : { code: stopCode },
    );
    return "Stopped.";
  }

  /** Speech is about to use the voice player. Video sink pauses the share. */
  public duck(): void {
    if (this.current === undefined || this.paused) return;
    try {
      if (this.sink.duck === undefined) this.sink.pause();
      else this.sink.duck();
    } catch (error) {
      this.emit("duck", "queue", "failed", this.current.trace, { code: musicFailureCode(error) });
      return;
    }
    this.emit("duck", "queue", "ducked", this.current.trace);
  }

  public unduck(): void {
    if (this.current === undefined || this.paused) return;
    try {
      if (this.sink.unduck === undefined) this.sink.resume();
      else this.sink.unduck();
    } catch (error) {
      this.emit("unduck", "queue", "failed", this.current.trace, { code: musicFailureCode(error) });
      return;
    }
    this.emit("unduck", "queue", "unducked", this.current.trace);
  }

  public dispose(): void {
    this.stop();
    try {
      this.sink.dispose?.();
    } catch {
      // Queue state is already empty; disposal is terminal and best effort.
    }
  }

  public async ended(): Promise<void> {
    if (this.paused) return;
    const next = this.queued.shift();
    if (next === undefined) {
      const trace = this.current?.trace;
      this.current = undefined;
      this.starting = false;
      let stopCode: string | undefined;
      try {
        this.sink.stop();
      } catch (error) {
        stopCode = musicFailureCode(error);
      }
      this.emit(
        "ended",
        "queue",
        stopCode === undefined ? "ended" : "failed",
        trace,
        stopCode === undefined ? {} : { code: stopCode },
      );
      return;
    }
    this.emit("ended", "queue", "ended", this.current?.trace);
    await this.start(next, "ended");
  }

  private async start(
    track: TrackedVoiceMusicTrack,
    operation: MusicControlAction | "ended",
  ): Promise<string> {
    this.current = track;
    this.paused = false;
    this.starting = true;
    try {
      await this.sink.play(track.track.url, track.trace);
    } catch (error) {
      if (this.current === track) {
        this.starting = false;
        this.current = undefined;
        this.queued.length = 0;
        this.paused = false;
      }
      this.emit(operation, "queue", "failed", track.trace, { code: musicFailureCode(error) });
      return "I couldn't start that track.";
    }
    if (this.current !== track) return "I couldn't start that track.";
    this.starting = false;
    this.emit(operation, "queue", "started", track.trace);
    return this.sinkKind === "video" ? `Streaming ${track.track.url}` : `Playing ${track.track.url}`;
  }

  private describe(trace?: VoiceMusicTraceContext): string {
    if (this.current === undefined) {
      this.emit("now", "queue", "empty", trace);
      return "Nothing is playing.";
    }
    this.emit("now", "queue", "reported", trace);
    const via = this.sinkKind === "video" ? "on the stream" : "in voice";
    const more = this.queued.length === 0 ? "" : ` ${String(this.queued.length)} waiting.`;
    const hold = this.paused ? " (paused)" : "";
    return `Now ${via}${hold}: ${this.current.track.url}.${more}`;
  }

  private emit(
    operation: VoiceMusicTraceEvent["operation"],
    component: VoiceMusicTraceEvent["component"],
    outcome: VoiceMusicTraceEvent["outcome"],
    trace?: VoiceMusicTraceContext,
    extra: Pick<VoiceMusicTraceEvent, "resultCount" | "exitCode" | "code"> = {},
  ): void {
    if (trace === undefined || this.trace === undefined) return;
    const snapshot = this.snapshot();
    this.trace({
      ...trace,
      operation,
      component,
      outcome,
      current: snapshot.current !== undefined,
      queuedCount: snapshot.queued.length,
      paused: snapshot.paused,
      ...extra,
    });
  }
}

export type MusicControlAction = "search" | "play" | "queue" | "skip" | "pause" | "resume" | "stop" | "now";

export interface MusicControlInput {
  readonly query?: string;
  readonly url?: string;
  readonly index?: number;
  readonly authorId?: string;
  readonly next?: boolean;
}

export interface MusicControlResult {
  readonly ok: boolean;
  readonly message: string;
}

export function parseMusicControlPath(url: string): MusicControlAction | undefined {
  const path = url.split("?")[0] ?? url;
  const match = /^\/music\/(search|play|queue|skip|pause|resume|stop|now)$/u.exec(path);
  const action = match?.[1];
  if (
    action === "search" ||
    action === "play" ||
    action === "queue" ||
    action === "skip" ||
    action === "pause" ||
    action === "resume" ||
    action === "stop" ||
    action === "now"
  ) {
    return action;
  }
  return undefined;
}

/** Shared by the lab body, the bot control port, and the captain's tools. */
export async function applyMusicControl(
  queue: VoiceMusicQueue,
  action: MusicControlAction,
  input: MusicControlInput = {},
  trace?: VoiceMusicTraceContext,
): Promise<MusicControlResult> {
  const authorId = input.authorId?.trim() || "unknown";
  switch (action) {
    case "search": {
      const query = input.query?.trim() ?? "";
      if (query.length === 0) return { ok: false, message: "Need a search query." };
      return {
        ok: true,
        message: await queue.searchAndOffer(authorId, query, input.next === true ? "queue" : "play", trace),
      };
    }
    case "play":
      if (typeof input.index === "number") {
        return { ok: true, message: await queue.pick(authorId, input.index, "play", trace) };
      }
      if (typeof input.url === "string") {
        return { ok: true, message: await queue.play(input.url, authorId, trace) };
      }
      return { ok: false, message: "Need a YouTube URL or a result number." };
    case "queue":
      if (typeof input.index === "number") {
        return { ok: true, message: await queue.pick(authorId, input.index, "queue", trace) };
      }
      if (typeof input.url === "string") {
        return { ok: true, message: await queue.enqueue(input.url, authorId, trace) };
      }
      return { ok: false, message: "Need a YouTube URL or a result number." };
    case "skip":
      return { ok: true, message: await queue.skip(trace) };
    case "pause":
      return { ok: true, message: queue.pause(trace) };
    case "resume":
      return { ok: true, message: queue.resume(trace) };
    case "stop":
      return { ok: true, message: queue.stop(trace) };
    case "now":
      return { ok: true, message: await queue.handle({ kind: "now" }, undefined, trace) };
  }
}

/**
 * Loopback `/music/*` for both Discord bodies. Returns true when this request
 * is a music control call (the handler owns the response).
 */
export function tryHandleMusicControlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  queue: VoiceMusicQueue | undefined,
  playbackReady = true,
): boolean {
  if (request.method !== "POST") return false;
  const action = parseMusicControlPath(request.url ?? "/");
  if (action === undefined) return false;
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  request.on("end", () => {
    void (async () => {
      try {
        const parsed =
          chunks.length === 0 ? {} : (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        const result =
          queue === undefined ||
          (!playbackReady &&
            (action === "play" || action === "queue" || action === "skip" || action === "resume"))
            ? { ok: false, message: "I can't play music until I'm in a voice channel." }
            : await applyMusicControl(queue, action, musicControlInputFromUnknown(parsed), {
                source: "control",
                callId: randomUUID(),
              });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, message: "invalid_json" }));
      }
    })();
  });
  return true;
}

function musicControlInputFromUnknown(value: unknown): MusicControlInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const body = value as Record<string, unknown>;
  return {
    ...(typeof body.query === "string" ? { query: body.query } : {}),
    ...(typeof body.url === "string" ? { url: body.url } : {}),
    ...(typeof body.index === "number" ? { index: body.index } : {}),
    ...(typeof body.authorId === "string" ? { authorId: body.authorId } : {}),
    ...(body.next === true ? { next: true } : {}),
  };
}

export async function searchYouTube(
  query: string,
  options: { readonly limit?: number; readonly spawnImpl?: typeof spawn; readonly timeoutMs?: number } = {},
): Promise<YouTubeSearchHit[]> {
  const trimmed = query.trim().slice(0, 200);
  if (trimmed.length === 0) return [];
  const limit = Math.min(Math.max(options.limit ?? MAX_SEARCH_RESULTS, 1), MAX_SEARCH_RESULTS);
  const spawnImpl = options.spawnImpl ?? spawn;
  return await new Promise((resolve) => {
    const child = spawnImpl(
      "yt-dlp",
      [
        "--flat-playlist",
        "--no-warnings",
        "--playlist-end",
        String(limit),
        "-J",
        `ytsearch${String(limit)}:${trimmed}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 1_500_000) child.kill("SIGKILL");
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve([]);
    }, options.timeoutMs ?? SEARCH_TIMEOUT_MS);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(parseYtDlpSearchJson(stdout));
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}

export function parseYtDlpSearchJson(raw: string): YouTubeSearchHit[] {
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];
    const hits: YouTubeSearchHit[] = [];
    for (const entry of parsed.entries) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const title = typeof record.title === "string" ? record.title.trim() : "";
      if (id.length === 0 || title.length === 0) continue;
      hits.push({
        videoId: id,
        url: `https://www.youtube.com/watch?v=${id}`,
        title: title.slice(0, 200),
        ...(typeof record.uploader === "string" ? { channel: record.uploader.slice(0, 80) } : {}),
        ...(typeof record.duration_string === "string" ? { duration: record.duration_string } : {}),
      });
      if (hits.length >= MAX_SEARCH_RESULTS) break;
    }
    return hits;
  } catch {
    return [];
  }
}

/** Native Vox music sink. Playback starts and ends only on matching native ids. */
export function createVoxMusicSink(options: {
  readonly vox: VoxClient;
  readonly onEnded?: () => void;
  readonly trace?: VoiceMusicTrace;
}): VoiceMusicSink {
  let current:
    | {
        readonly musicId: string;
        readonly trace?: VoiceMusicTraceContext;
        resolve: (() => void) | undefined;
        reject: ((error: Error) => void) | undefined;
      }
    | undefined;

  const emit = (
    operation: VoiceMusicTraceEvent["operation"],
    outcome: VoiceMusicTraceEvent["outcome"],
    trace?: VoiceMusicTraceContext,
    code?: string,
  ): void => {
    if (trace === undefined) return;
    options.trace?.({
      ...trace,
      operation,
      component: "player",
      outcome,
      ...(code === undefined ? {} : { code }),
    });
  };
  const fail = (musicId: string, code: string): void => {
    const active = current;
    if (active === undefined || active.musicId !== musicId) return;
    current = undefined;
    active.reject?.(new Error(`Vox music failed: ${code}`));
    emit("play", "failed", active.trace, code);
    if (active.resolve === undefined) notifyEnded();
  };
  const failCommand = (musicId: string, error: unknown): void => {
    const active = current;
    if (active === undefined || active.musicId !== musicId) return;
    const code = musicFailureCode(error);
    current = undefined;
    active.reject?.(error instanceof Error ? error : new Error(`Vox music failed: ${code}`));
    emit("play", "failed", active.trace, code);
    if (active.resolve === undefined) notifyEnded();
  };
  const notifyEnded = (): void => {
    try {
      options.onEnded?.();
    } catch {
      // Queue cleanup must not escape a Vox status callback.
    }
  };
  const onEvent = (event: VoxControlEvent): void => {
    const active = current;
    if (active === undefined) return;
    if (event.type === "player_state" && event.musicId === active.musicId && event.status === "playing") {
      active.resolve?.();
      active.resolve = undefined;
      active.reject = undefined;
      emit("play", "playing", active.trace);
      return;
    }
    if (event.type === "music_idle" && event.musicId === active.musicId) {
      current = undefined;
      if (active.resolve !== undefined) active.reject?.(new Error("Vox music ended before playback started"));
      else notifyEnded();
      return;
    }
    if (event.type === "music_error") fail(event.musicId, event.code);
  };
  const offEvent = options.vox.onEvent(onEvent);
  const offStatus = options.vox.onStatus((status) => {
    const active = current;
    if (active !== undefined && (status === "error" || status === "closed" || status === "missing")) {
      fail(active.musicId, `vox_${status}`);
    }
  });

  return {
    play(url, trace) {
      const previous = current;
      if (previous !== undefined) {
        current = undefined;
        previous.reject?.(new Error("Vox music replaced"));
        try {
          options.vox.musicStop(previous.musicId);
        } catch {
          // The replacement still gets its own independent command.
        }
      }
      const musicId = randomUUID();
      return new Promise<void>((resolve, reject) => {
        current = { musicId, ...(trace === undefined ? {} : { trace }), resolve, reject };
        try {
          options.vox.musicPlay({ musicId, url });
          emit("play", "submitted", trace);
        } catch (error) {
          failCommand(musicId, error);
        }
      });
    },
    pause() {
      if (current !== undefined) options.vox.musicPause(current.musicId);
    },
    resume() {
      if (current !== undefined) options.vox.musicResume(current.musicId);
    },
    stop() {
      const active = current;
      current = undefined;
      active?.reject?.(new Error("Vox music stopped"));
      if (active !== undefined) options.vox.musicStop(active.musicId);
    },
    duck() {
      if (current !== undefined) options.vox.musicSetGain(current.musicId, 0.2, 150);
    },
    unduck() {
      if (current !== undefined) options.vox.musicSetGain(current.musicId, 1, 150);
    },
    dispose() {
      const active = current;
      current = undefined;
      active?.reject?.(new Error("Vox music disposed"));
      try {
        if (active !== undefined) options.vox.musicStop(active.musicId);
      } catch {
        // Local sink state is already empty.
      } finally {
        offEvent();
        offStatus();
      }
    },
  };
}
