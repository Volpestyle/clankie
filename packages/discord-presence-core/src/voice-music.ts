import { spawn, type ChildProcess } from "node:child_process";
import { createAudioResource, StreamType, type AudioPlayer } from "@discordjs/voice";

/**
 * Shared DJ queue for the active Discord mouth.
 *
 * Audio-in-voice is the common sink (official bot, or lab body without
 * ClankVox). The lab user body may also attach a video sink — Go Live the
 * same URL — so a YouTube request can be a stream, not only a song. The
 * queue never starts both sinks for one track: that would double the audio.
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

/** Transport-specific play/pause/stop. One track, one sink. */
export interface VoiceMusicSink {
  play(url: string): Promise<void> | void;
  pause(): void;
  resume(): void;
  stop(): void;
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

export type VoiceMusicIntent =
  | VoiceMusicCommand
  | { readonly kind: "play_search"; readonly query: string }
  | { readonly kind: "queue_search"; readonly query: string }
  | { readonly kind: "pick"; readonly index: number }
  | { readonly kind: "song_clarify" };

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

/**
 * Deterministic chat control. No model call.
 *
 * Accepts `play <url>`, `queue <url>`, skip/next, pause, resume, stop,
 * now/np, optional `!`/`/` prefix, and a bare YouTube URL (queues if
 * something is already up).
 */
export async function dispatchVoiceMusicChat(input: {
  readonly body: string;
  readonly authorId: string;
  readonly names?: readonly string[];
  readonly addressed?: boolean;
  readonly queue: VoiceMusicQueue;
}): Promise<string | undefined> {
  return input.queue.handleUtterance(input.body, input.authorId, input.names ?? [], input.addressed === true);
}

export function parseVoiceMusicCommand(
  body: string,
  options: { readonly names?: readonly string[]; readonly hasCurrent?: boolean } = {},
): VoiceMusicCommand | undefined {
  const intent = parseMusicIntent(body, options);
  if (intent === undefined) return undefined;
  if (
    intent.kind === "play" ||
    intent.kind === "queue" ||
    intent.kind === "skip" ||
    intent.kind === "pause" ||
    intent.kind === "resume" ||
    intent.kind === "stop" ||
    intent.kind === "now"
  ) {
    return intent;
  }
  return undefined;
}

/**
 * Chat and voice share this parser. URLs and transport verbs stay
 * deterministic; "play migos next" becomes a YouTube search, not a captain turn.
 */
export function parseMusicIntent(
  body: string,
  options: {
    readonly names?: readonly string[];
    readonly hasCurrent?: boolean;
    readonly addressed?: boolean;
  } = {},
): VoiceMusicIntent | undefined {
  const stripped = stripAddress(body, options.names ?? []).trim();
  if (stripped.length === 0) return undefined;
  const unprefixed = stripped.replace(/^[!/]/u, "").trim();
  const pick = parsePick(unprefixed);
  if (pick !== undefined) return pick;

  if (/^(skip(?:\s+(?:this|it|the song))?|next(?:\s+song)?)$/iu.test(unprefixed)) return { kind: "skip" };
  if (/^pause(?:\s+(?:it|the music|the song))?$/iu.test(unprefixed)) return { kind: "pause" };
  if (/^(?:resume|unpause|continue)(?:\s+(?:it|the music|the song))?$/iu.test(unprefixed)) {
    return { kind: "resume" };
  }
  if (/^stop(?:\s+(?:it|the music|playing))?$/iu.test(unprefixed)) return { kind: "stop" };
  if (/^(?:now(?:\s+playing)?|np|what(?:'s| is) playing)$/iu.test(unprefixed)) return { kind: "now" };
  if (
    /^(?:(?:i mean|i meant|no,?)\s+)?(?:the |a )?(?:song|track|tune|banger)(?:\s+please)?$/iu.test(
      unprefixed,
    )
  ) {
    return { kind: "song_clarify" };
  }
  const titled = /^(?:(?:play|put on)\s+)?(?:the |a )?(?:song|track)\s+(.+)$/iu.exec(unprefixed);
  if (titled?.[1] !== undefined) {
    const intent = searchOrUrl("play", titled[1]);
    if (intent !== undefined) return intent;
  }

  const [head, ...rest] = unprefixed.split(/\s+/u);
  if (head === undefined) return undefined;
  const verb = head.toLowerCase();
  const tail = rest.join(" ").trim();

  if (verb === "play" && isAllowedMusicUrl(tail)) return { kind: "play", url: tail };
  if ((verb === "queue" || verb === "q") && isAllowedMusicUrl(tail)) return { kind: "queue", url: tail };
  if (rest.length === 0 && isAllowedMusicUrl(head)) {
    return options.hasCurrent === true ? { kind: "queue", url: head } : { kind: "play", url: head };
  }

  const playNext = /(?:play|put on)\s+(.+?)\s+next$/iu.exec(unprefixed);
  if (playNext?.[1] !== undefined) {
    const intent = searchOrUrl("queue", playNext[1]);
    if (intent !== undefined) return intent;
  }
  const queue = /(?:queue|q|play next)\s+(.+)$/iu.exec(unprefixed);
  if (queue?.[1] !== undefined) {
    const intent = searchOrUrl("queue", queue[1]);
    if (intent !== undefined) return intent;
  }
  const play = /(?:play|put on(?: some)?)\s+(?:me\s+|us\s+|some\s+)?(.+)$/iu.exec(unprefixed);
  if (play?.[1] !== undefined) {
    const intent = searchOrUrl("play", play[1]);
    if (intent !== undefined) return intent;
  }
  return undefined;
}

function searchOrUrl(action: "play" | "queue", raw: string): VoiceMusicIntent | undefined {
  const query = raw
    .trim()
    .replace(/[.?!]+$/u, "")
    .trim();
  if (query.length < 2) return undefined;
  if (isGamePlayRequest(query)) return undefined;
  if (isAllowedMusicUrl(query)) return { kind: action, url: query };
  return { kind: action === "play" ? "play_search" : "queue_search", query };
}

/** Leave "play pokemon" to the play-session captain. */
function isGamePlayRequest(query: string): boolean {
  return /^(?:pokemon|pokémon|firered|fire\s*red|leafgreen|leaf\s*green|emerald|minecraft|gba|the game|with me|the run)$/iu.test(
    query,
  );
}

function parsePick(text: string): { kind: "pick"; index: number } | undefined {
  const direct = /^(?:number\s+|no\.?\s+|#\s*)?(\d+)$/iu.exec(text);
  if (direct?.[1] !== undefined) {
    const index = Number.parseInt(direct[1], 10);
    if (index >= 1 && index <= MAX_SEARCH_RESULTS) return { kind: "pick", index };
  }
  const ordinal = /^(?:the\s+)?(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)(?:\s+one)?$/iu.exec(
    text,
  );
  if (ordinal?.[1] === undefined) return undefined;
  const map: Record<string, number> = {
    first: 1,
    second: 2,
    third: 3,
    fourth: 4,
    fifth: 5,
    "1st": 1,
    "2nd": 2,
    "3rd": 3,
    "4th": 4,
    "5th": 5,
  };
  const index = map[ordinal[1].toLowerCase()];
  return index === undefined ? undefined : { kind: "pick", index };
}

export class VoiceMusicQueue {
  private readonly sink: VoiceMusicSink;
  private readonly queued: VoiceMusicTrack[] = [];
  private current: VoiceMusicTrack | undefined;
  private paused = false;
  private readonly sinkKind: "audio" | "video";
  private readonly searchImpl: typeof searchYouTube;
  private readonly now: () => number;
  private readonly pendingPicks = new Map<
    string,
    { readonly hits: readonly YouTubeSearchHit[]; readonly action: "play" | "queue"; readonly at: number }
  >();
  private readonly lastQuery = new Map<string, { readonly query: string; readonly action: "play" | "queue"; readonly at: number }>();

  public constructor(options: {
    readonly sink: VoiceMusicSink;
    readonly sinkKind: "audio" | "video";
    readonly search?: typeof searchYouTube;
    readonly now?: () => number;
  }) {
    this.sink = options.sink;
    this.sinkKind = options.sinkKind;
    this.searchImpl = options.search ?? searchYouTube;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * One entry for text and voice. Returns a reply to speak or send, or
   * undefined when the utterance is not a music request.
   */
  public async handleUtterance(
    body: string,
    authorId: string,
    names: readonly string[] = [],
    addressed = false,
  ): Promise<string | undefined> {
    const intent = parseMusicIntent(body, {
      names,
      hasCurrent: this.current !== undefined,
      addressed,
    });
    if (intent === undefined) return undefined;
    const spokenTo =
      addressed || namesMentioned(body, names) || isDirectedPlayRequest(stripAddress(body, names));
    if (intent.kind === "pick") {
      if (!this.pendingPicks.has(authorId)) return undefined;
      return this.pick(authorId, intent.index);
    }
    if (
      (intent.kind === "skip" ||
        intent.kind === "pause" ||
        intent.kind === "resume" ||
        intent.kind === "stop" ||
        intent.kind === "now") &&
      this.current === undefined &&
      this.queued.length === 0
    ) {
      return undefined;
    }
    if (
      (intent.kind === "play_search" || intent.kind === "queue_search") &&
      !spokenTo &&
      names.length > 0
    ) {
      return undefined;
    }
    if (intent.kind === "song_clarify") return this.clarifySong(authorId);
    if (intent.kind === "play_search") return this.searchAndOffer(authorId, intent.query, "play");
    if (intent.kind === "queue_search") return this.searchAndOffer(authorId, intent.query, "queue");
    return this.handle(intent, authorId);
  }

  public async clarifySong(authorId: string): Promise<string> {
    const pending = this.pendingPicks.get(authorId);
    if (pending !== undefined && this.now() - pending.at <= PENDING_PICK_TTL_MS) {
      return this.pick(authorId, 1);
    }
    const hint = this.lastQuery.get(authorId);
    if (hint !== undefined && this.now() - hint.at <= PENDING_PICK_TTL_MS) {
      return this.searchAndOffer(authorId, hint.query, hint.action);
    }
    return "Which song? Say play <title> and I'll search YouTube.";
  }

  public async searchAndOffer(
    authorId: string,
    query: string,
    action: "play" | "queue",
  ): Promise<string> {
    this.lastQuery.set(authorId, { query, action, at: this.now() });
    const hits = await this.searchImpl(query);
    if (hits.length === 0) return `I couldn't find YouTube results for "${query.slice(0, 80)}".`;
    this.pendingPicks.set(authorId, { hits, action, at: this.now() });
    const lines = hits.map((hit, index) => {
      const who = hit.channel === undefined ? "" : ` — ${hit.channel}`;
      const length = hit.duration === undefined ? "" : ` (${hit.duration})`;
      return `${String(index + 1)}. ${hit.title}${who}${length}`;
    });
    const verb = action === "queue" ? "queue" : "play";
    return `I found these:\n${lines.join("\n")}\nSay a number to ${verb} it.`;
  }

  public async pick(authorId: string, index: number): Promise<string> {
    const pending = this.pendingPicks.get(authorId);
    if (pending === undefined || this.now() - pending.at > PENDING_PICK_TTL_MS) {
      this.pendingPicks.delete(authorId);
      return "I don't have a search waiting. Ask me to play something first.";
    }
    const hit = pending.hits[index - 1];
    if (hit === undefined) return `Pick a number from 1 to ${String(pending.hits.length)}.`;
    this.pendingPicks.delete(authorId);
    return pending.action === "queue" ? this.enqueue(hit.url, authorId) : this.play(hit.url, authorId);
  }

  public snapshot(): VoiceMusicSnapshot {
    return {
      current: this.current,
      queued: [...this.queued],
      paused: this.paused,
      sink: this.sinkKind,
    };
  }

  public async handle(command: VoiceMusicCommand, requestedBy?: string): Promise<string> {
    switch (command.kind) {
      case "play":
        return this.play(command.url, requestedBy);
      case "queue":
        return this.enqueue(command.url, requestedBy);
      case "skip":
        return this.skip();
      case "pause":
        return this.pause();
      case "resume":
        return this.resume();
      case "stop":
        return this.stop();
      case "now":
        return this.describe();
    }
  }

  public async play(url: string, requestedBy?: string): Promise<string> {
    if (!isAllowedMusicUrl(url)) return "I can only play YouTube links.";
    this.queued.length = 0;
    this.paused = false;
    return this.start({ url, ...(requestedBy === undefined ? {} : { requestedBy }) });
  }

  public async enqueue(url: string, requestedBy?: string): Promise<string> {
    if (!isAllowedMusicUrl(url)) return "I can only queue YouTube links.";
    if (this.current === undefined) return this.play(url, requestedBy);
    if (this.queued.length >= MAX_QUEUE) return "Queue is full.";
    this.queued.push({ url, ...(requestedBy === undefined ? {} : { requestedBy }) });
    return `Queued (${String(this.queued.length)} waiting).`;
  }

  public async skip(): Promise<string> {
    if (this.current === undefined) return "Nothing is playing.";
    this.sink.stop();
    const next = this.queued.shift();
    if (next === undefined) {
      this.current = undefined;
      this.paused = false;
      return "Skipped. Queue is empty.";
    }
    return this.start(next);
  }

  public pause(): string {
    if (this.current === undefined) return "Nothing is playing.";
    if (this.paused) return "Already paused.";
    this.sink.pause();
    this.paused = true;
    return "Paused.";
  }

  public resume(): string {
    if (this.current === undefined) return "Nothing is playing.";
    if (!this.paused) return "Already playing.";
    this.sink.resume();
    this.paused = false;
    return "Resumed.";
  }

  public stop(): string {
    if (this.current === undefined && this.queued.length === 0) return "Nothing is playing.";
    this.sink.stop();
    this.current = undefined;
    this.queued.length = 0;
    this.paused = false;
    return "Stopped.";
  }

  /** Speech is about to use the voice player. Video sink pauses the share. */
  public duck(): void {
    if (this.current === undefined || this.paused) return;
    this.sink.pause();
  }

  public unduck(): void {
    if (this.current === undefined || this.paused) return;
    this.sink.resume();
  }

  public async ended(): Promise<void> {
    if (this.paused) return;
    const next = this.queued.shift();
    if (next === undefined) {
      this.current = undefined;
      this.sink.stop();
      return;
    }
    await this.start(next);
  }

  private async start(track: VoiceMusicTrack): Promise<string> {
    this.current = track;
    this.paused = false;
    try {
      await this.sink.play(track.url);
    } catch {
      this.current = undefined;
      return "I'm not in a voice channel.";
    }
    return this.sinkKind === "video" ? `Streaming ${track.url}` : `Playing ${track.url}`;
  }

  private describe(): string {
    if (this.current === undefined) return "Nothing is playing.";
    const via = this.sinkKind === "video" ? "on the stream" : "in voice";
    const more = this.queued.length === 0 ? "" : ` ${String(this.queued.length)} waiting.`;
    const hold = this.paused ? " (paused)" : "";
    return `Now ${via}${hold}: ${this.current.url}.${more}`;
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
): Promise<MusicControlResult> {
  const authorId = input.authorId?.trim() || "unknown";
  switch (action) {
    case "search": {
      const query = input.query?.trim() ?? "";
      if (query.length === 0) return { ok: false, message: "Need a search query." };
      return {
        ok: true,
        message: await queue.searchAndOffer(authorId, query, input.next === true ? "queue" : "play"),
      };
    }
    case "play":
      if (typeof input.index === "number") return { ok: true, message: await queue.pick(authorId, input.index) };
      if (typeof input.url === "string") return { ok: true, message: await queue.play(input.url, authorId) };
      return { ok: false, message: "Need a YouTube URL or a result number." };
    case "queue":
      if (typeof input.index === "number") {
        // Force queue even if the last search was a play-now offer.
        const picked = await queue.pick(authorId, input.index);
        return { ok: true, message: picked };
      }
      if (typeof input.url === "string") return { ok: true, message: await queue.enqueue(input.url, authorId) };
      return { ok: false, message: "Need a YouTube URL or a result number." };
    case "skip":
      return { ok: true, message: await queue.skip() };
    case "pause":
      return { ok: true, message: queue.pause() };
    case "resume":
      return { ok: true, message: queue.resume() };
    case "stop":
      return { ok: true, message: queue.stop() };
    case "now":
      return { ok: true, message: await queue.handle({ kind: "now" }) };
  }
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
}): VoiceMusicSink {
  const spawnImpl = options.spawnImpl ?? spawn;
  let child: ChildProcess | undefined;
  let currentUrl: string | undefined;
  let startedAt = 0;
  let seekSeconds = 0;

  const stopChild = (): void => {
    if (child === undefined) return;
    child.kill("SIGKILL");
    child = undefined;
  };

  const startAt = (url: string, seek: number): void => {
    stopChild();
    currentUrl = url;
    seekSeconds = seek;
    startedAt = Date.now();
    const ffmpegSeek = seek > 0 ? ["-ss", seek.toFixed(1)] : [];
    const pipeline = spawnImpl(
      "sh",
      [
        "-c",
        `yt-dlp -f ba/bestaudio -o - --no-playlist --no-warnings ${JSON.stringify(url)} | ffmpeg -hide_banner -loglevel error ${ffmpegSeek.join(" ")} -i pipe:0 -f s16le -ar 48000 -ac 2 pipe:1`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child = pipeline;
    options.player.play(createAudioResource(pipeline.stdout, { inputType: StreamType.Raw }));
    pipeline.stdout.once("end", () => {
      if (currentUrl !== url) return;
      child = undefined;
      options.onEnded?.();
    });
  };

  return {
    play(url) {
      startAt(url, 0);
    },
    pause() {
      if (currentUrl === undefined) return;
      seekSeconds += Math.max(0, (Date.now() - startedAt) / 1_000);
      stopChild();
      options.player.pause(true);
    },
    resume() {
      if (currentUrl === undefined) return;
      startAt(currentUrl, seekSeconds);
    },
    stop() {
      currentUrl = undefined;
      seekSeconds = 0;
      stopChild();
      options.player.stop(true);
    },
  };
}

function isDirectedPlayRequest(body: string): boolean {
  return /^(?:(?:can|could|would|will)\s+(?:you|u|ya)\b|please\b|come(?:\s+and)?\s+play\b)/iu.test(
    body.trim(),
  );
}

function namesMentioned(body: string, names: readonly string[]): boolean {
  if (names.length === 0) return false;
  const haystack = body.toLowerCase();
  return names.some((name) => {
    const needle = name.trim().toLowerCase();
    if (needle.length === 0) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "u").test(haystack);
  });
}

function stripAddress(body: string, names: readonly string[]): string {
  let next = body.trim();
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    next = next.replace(new RegExp(`^@?${escaped}[,:]?\\s+`, "iu"), "");
  }
  return next;
}
