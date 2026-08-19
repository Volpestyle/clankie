import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { AudioPlayerStatus, createAudioResource, StreamType, type AudioPlayer } from "@discordjs/voice";

/**
 * Shared DJ queue for the active Discord mouth.
 *
 * The model (captain text tools or the voice realtime tools) searches and
 * picks. This module is the sink and the structured control surface — it
 * never parses chat. Audio-in-voice is the common sink (official bot, or
 * lab body without ClankVox). The lab user body may also attach a video
 * sink — Go Live the same URL — so a YouTube request can be a stream, not
 * only a song. The queue never starts both sinks for one track: that would
 * double the audio.
 */

export type VoiceMusicCommandKind = "play" | "queue" | "skip" | "pause" | "resume" | "stop" | "now";

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
}

interface TrackedVoiceMusicTrack {
  readonly track: VoiceMusicTrack;
  readonly trace?: VoiceMusicTraceContext;
}

const MAX_QUEUE = 32;
const MAX_SEARCH_RESULTS = 5;
const PENDING_PICK_TTL_MS = 120_000;
const SEARCH_TIMEOUT_MS = 15_000;

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
    this.sink.stop();
    const next = this.queued.shift();
    if (next === undefined) {
      this.current = undefined;
      this.paused = false;
      this.emit("skip", "queue", "skipped", trace);
      return "Skipped. Queue is empty.";
    }
    this.emit("skip", "queue", "skipped", trace);
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
    this.sink.pause();
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
    this.sink.resume();
    this.paused = false;
    this.emit("resume", "queue", "resumed", trace);
    return "Resumed.";
  }

  public stop(trace?: VoiceMusicTraceContext): string {
    if (this.current === undefined && this.queued.length === 0) {
      this.emit("stop", "queue", "empty", trace);
      return "Nothing is playing.";
    }
    this.sink.stop();
    this.current = undefined;
    this.queued.length = 0;
    this.paused = false;
    this.emit("stop", "queue", "stopped", trace);
    return "Stopped.";
  }

  /** Speech is about to use the voice player. Video sink pauses the share. */
  public duck(): void {
    if (this.current === undefined || this.paused) return;
    this.sink.pause();
    this.emit("duck", "queue", "ducked", this.current.trace);
  }

  public unduck(): void {
    if (this.current === undefined || this.paused) return;
    this.sink.resume();
    this.emit("unduck", "queue", "unducked", this.current.trace);
  }

  public async ended(): Promise<void> {
    if (this.paused) return;
    const next = this.queued.shift();
    if (next === undefined) {
      const trace = this.current?.trace;
      this.current = undefined;
      this.sink.stop();
      this.emit("ended", "queue", "ended", trace);
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
    try {
      await this.sink.play(track.track.url, track.trace);
    } catch {
      this.current = undefined;
      this.emit(operation, "queue", "failed", track.trace, { code: "music_sink_rejected" });
      return "I couldn't start that track.";
    }
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

/**
 * YouTube → PCM → the shared voice AudioPlayer.
 *
 * Used when the official bot is the mouth, or when the lab body has no
 * video sink. Ducking stops the pipeline and remembers elapsed time so
 * speech can own the player, then restarts with `-ss`.
 */
export function createYoutubeAudioSink(options: {
  readonly player: AudioPlayer;
  readonly spawnImpl?: typeof spawn;
  readonly onEnded?: () => void;
  readonly trace?: VoiceMusicTrace;
}): VoiceMusicSink {
  const spawnImpl = options.spawnImpl ?? spawn;
  let children: ChildProcess[] = [];
  let removePlayerListener: (() => void) | undefined;
  let currentUrl: string | undefined;
  let currentTrace: VoiceMusicTraceContext | undefined;
  let startedAt = 0;
  let seekSeconds = 0;
  let pipelineGeneration = 0;
  let pendingStart: { readonly generation: number; readonly reject: (error: Error) => void } | undefined;

  const emit = (
    operation: VoiceMusicTraceEvent["operation"],
    component: VoiceMusicTraceEvent["component"],
    outcome: VoiceMusicTraceEvent["outcome"],
    trace: VoiceMusicTraceContext | undefined,
    extra: Pick<VoiceMusicTraceEvent, "exitCode" | "code"> = {},
  ): void => {
    if (trace === undefined) return;
    options.trace?.({ ...trace, operation, component, outcome, ...extra });
  };

  const stopChildren = (): void => {
    pendingStart?.reject(new Error("music pipeline stopped"));
    pendingStart = undefined;
    pipelineGeneration += 1;
    removePlayerListener?.();
    removePlayerListener = undefined;
    for (const child of children) child.kill("SIGKILL");
    children = [];
  };

  const observeProcess = (
    child: ChildProcess,
    component: "yt_dlp" | "ffmpeg",
    operation: "play" | "resume",
    trace: VoiceMusicTraceContext | undefined,
    attemptCode: string,
    failureCode?: () => string | undefined,
  ): void => {
    child.once("spawn", () => emit(operation, component, "spawned", trace, { code: attemptCode }));
    child.once("error", () => emit(operation, component, "failed", trace, { code: "spawn_failed" }));
    child.once("close", (code, signal) => {
      emit(operation, component, "exited", trace, {
        ...(typeof code === "number" && code >= 0 ? { exitCode: code } : {}),
        ...(typeof code === "number" && code !== 0
          ? { code: failureCode?.() ?? "nonzero_exit" }
          : signal === null
            ? { code: attemptCode }
            : { code: signal.toLowerCase() }),
      });
    });
  };

  const startAttempt = (
    url: string,
    seek: number,
    trace: VoiceMusicTraceContext | undefined,
    operation: "play" | "resume",
    generation: number,
    attemptCode: string,
    selector: string,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      let settled = false;
      let receivedAudio = false;
      const fail = (error: Error): void => {
        if (settled || generation !== pipelineGeneration) return;
        settled = true;
        if (pendingStart?.generation === generation) pendingStart = undefined;
        reject(error);
      };
      pendingStart = { generation, reject: fail };
      const ffmpegSeek = seek > 0 ? ["-ss", seek.toFixed(1)] : [];
      const downloader = spawnImpl(
        "yt-dlp",
        ["-f", selector, "-o", "-", "--no-playlist", "--no-warnings", "--no-progress", url],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const transcoder = spawnImpl(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          ...ffmpegSeek,
          "-i",
          "pipe:0",
          "-f",
          "s16le",
          "-ar",
          "48000",
          "-ac",
          "2",
          "pipe:1",
        ],
        { stdio: ["pipe", "pipe", "ignore"] },
      );
      children = [downloader, transcoder];
      let downloaderStderr = "";
      downloader.stderr?.setEncoding("utf8");
      downloader.stderr?.on("data", (chunk: string) => {
        downloaderStderr = `${downloaderStderr}${chunk}`.slice(-8_192);
      });
      observeProcess(downloader, "yt_dlp", operation, trace, attemptCode, () =>
        /HTTP Error 403/iu.test(downloaderStderr) ? "http_403" : undefined,
      );
      observeProcess(transcoder, "ffmpeg", operation, trace, attemptCode);
      const downloadOutput = downloader.stdout;
      const transcodeInput = transcoder.stdin;
      const output = transcoder.stdout;
      if (downloadOutput === null || transcodeInput === null || output === null) {
        fail(new Error("music pipeline stdio unavailable"));
        return;
      }
      downloadOutput.pipe(transcodeInput);
      const failBeforeAudio = (): void => {
        if (!receivedAudio) fail(new Error("music pipeline ended before audio"));
      };
      downloader.once("error", failBeforeAudio);
      transcoder.once("error", failBeforeAudio);
      downloader.once("close", (code, signal) => {
        if (code !== 0 || signal !== null) failBeforeAudio();
      });
      transcoder.once("close", (code, signal) => {
        if (code !== 0 || signal !== null) failBeforeAudio();
      });
      output.once("data", () => {
        if (generation !== pipelineGeneration) return;
        receivedAudio = true;
        settled = true;
        if (pendingStart?.generation === generation) pendingStart = undefined;
        emit(operation, "pipeline", "first_audio", trace, { code: attemptCode });
        resolve();
      });
      const onPlayerState = (_previous: { status: string }, next: { status: string }): void => {
        if (next.status === AudioPlayerStatus.Playing) emit(operation, "player", "playing", trace);
        if (next.status === AudioPlayerStatus.Idle) emit(operation, "player", "idle", trace);
      };
      options.player.on("stateChange", onPlayerState);
      removePlayerListener = () => options.player.off("stateChange", onPlayerState);
      options.player.play(createAudioResource(output, { inputType: StreamType.Raw }));
      emit(operation, "player", "submitted", trace, { code: attemptCode });
      output.once("end", () => {
        if (!receivedAudio) {
          failBeforeAudio();
          return;
        }
        if (generation !== pipelineGeneration || currentUrl !== url) return;
        options.onEnded?.();
      });
    });

  const startAt = async (
    url: string,
    seek: number,
    trace: VoiceMusicTraceContext | undefined,
    operation: "play" | "resume",
  ): Promise<void> => {
    stopChildren();
    currentUrl = url;
    currentTrace = trace;
    seekSeconds = seek;
    startedAt = Date.now();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const generation = pipelineGeneration;
      const attemptCode = attempt === 0 ? "attempt_1_direct" : "attempt_2_hls";
      try {
        await startAttempt(
          url,
          seek,
          trace,
          operation,
          generation,
          attemptCode,
          attempt === 0
            ? "ba/bestaudio"
            : "worst[protocol^=m3u8][height>=360][acodec!=none]/worst[protocol^=m3u8][acodec!=none]",
        );
        return;
      } catch (error) {
        if (generation !== pipelineGeneration || currentUrl !== url) throw error;
        if (attempt === 0) {
          emit(operation, "pipeline", "failed", trace, { code: "pre_audio_retry" });
          stopChildren();
          continue;
        }
        emit(operation, "pipeline", "failed", trace, { code: "pre_audio_failed" });
        currentUrl = undefined;
        currentTrace = undefined;
        seekSeconds = 0;
        stopChildren();
        if (operation === "resume") options.onEnded?.();
        throw error;
      }
    }
  };

  return {
    play(url, trace) {
      return startAt(url, 0, trace, "play");
    },
    pause() {
      if (currentUrl === undefined) return;
      seekSeconds += Math.max(0, (Date.now() - startedAt) / 1_000);
      stopChildren();
      options.player.pause(true);
      emit("pause", "player", "paused", currentTrace);
    },
    resume() {
      if (currentUrl === undefined) return;
      void startAt(currentUrl, seekSeconds, currentTrace, "resume").catch(() => undefined);
    },
    stop() {
      const trace = currentTrace;
      currentUrl = undefined;
      currentTrace = undefined;
      seekSeconds = 0;
      stopChildren();
      options.player.stop(true);
      emit("stop", "player", "stopped", trace);
    },
  };
}
