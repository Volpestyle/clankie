import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const FRAME_HEADER_BYTES = 5;
const USER_AUDIO_HEADER_BYTES = 20;
const MAX_STDIN_LINE_BYTES = 8 * 1024 * 1024;
const MAX_BROWSER_FRAME_BASE64_BYTES = 7_500_000;
const MAX_QUEUED_CONTROL_COMMANDS = 256;
const GRACEFUL_CLOSE_TIMEOUT_MS = 2_000;
const BROWSER_FRAME_MIME_TYPE = "image/png";
const PROCESS_READY_TIMEOUT_MS = 5_000;

// Bump with apps/vox/src/ipc.rs; mismatches are intentionally fatal.
export const VOX_IPC_PROTOCOL_VERSION = 1;

export type VoxProcessStatus = "missing" | "starting" | "ready" | "error" | "closed";
export type VoxTransportRole = "voice" | "stream_watch" | "stream_publish";
export type VoxUnsubscribe = () => void;
export type VoxListenerRegistration = VoxUnsubscribe | void;

export interface VoxDecodedVideoFrame {
  readonly role: VoxTransportRole;
  readonly userId: string;
  readonly width: number;
  readonly height: number;
  readonly jpegBase64: string;
}

export interface VoxUserAudioFrame {
  readonly userId: string;
  readonly captureId: string;
  readonly signalPeakAbs: number;
  readonly signalActiveSampleCount: number;
  readonly signalSampleCount: number;
  readonly pcm: Uint8Array;
}

type VoxTransportScope =
  | { readonly role: "voice"; readonly connectionId: string }
  | {
      readonly role: Exclude<VoxTransportRole, "voice">;
      readonly connectionId?: never;
    };

export type VoxTransportError =
  | ({ readonly type: "error"; readonly code: "voice_connect_failed"; readonly message: string } & {
      readonly role: "voice";
      readonly connectionId: string;
    })
  | {
      readonly type: "error";
      readonly code: "stream_watch_connect_failed";
      readonly message: string;
      readonly role: "stream_watch";
      readonly connectionId?: never;
    }
  | {
      readonly type: "error";
      readonly code: "stream_publish_connect_failed";
      readonly message: string;
      readonly role: "stream_publish";
      readonly connectionId?: never;
    }
  | ({
      readonly type: "error";
      readonly code: "voice_runtime_error";
      readonly message: string;
    } & VoxTransportScope);

export type VoxMusicErrorCode =
  | "http_403"
  | "format_unavailable"
  | "spawn_failed"
  | "missing_stdout"
  | "no_audio"
  | "pipeline_failed"
  | "wait_failed";

export type VoxClientErrorCode =
  | "protocol_missing"
  | "protocol_mismatch"
  | "not_ready"
  | "input_too_large"
  | "stdin_queue_overflow"
  | "stdin_write_failed"
  | "closed";

export class VoxClientError extends Error {
  public readonly code: VoxClientErrorCode;
  public readonly correlationId?: string;

  public constructor(code: VoxClientErrorCode, message: string, correlationId?: string) {
    super(message);
    this.name = "VoxClientError";
    this.code = code;
    if (correlationId !== undefined) this.correlationId = correlationId;
  }
}

export type VoxControlEvent =
  | { readonly type: "process_ready"; readonly protocolVersion: number }
  | { readonly type: "ready"; readonly connectionId: string }
  | { readonly type: "adapter_send"; readonly payload: unknown }
  | { readonly type: "connection_state"; readonly status: string; readonly connectionId: string }
  | ({
      readonly type: "transport_state";
      readonly status: string;
      readonly reason?: string;
    } & VoxTransportScope)
  | ({
      readonly type: "dave_state";
      readonly status: "negotiating" | "ready" | "disabled" | "cleared";
      readonly protocolVersion?: number;
    } & VoxTransportScope)
  | { readonly type: "player_state"; readonly status: string; readonly musicId?: string }
  | { readonly type: "playback_armed"; readonly reason: string }
  | {
      readonly type: "tts_playback_state";
      readonly playbackId: string;
      readonly status: "buffered" | "started" | "drained" | "stopped" | "failed";
      readonly reason?: string;
    }
  | {
      readonly type: "speaking_start" | "speaking_end";
      readonly userId: string;
      readonly captureId?: string;
    }
  | { readonly type: "user_audio_end"; readonly userId: string; readonly captureId: string }
  | {
      readonly type: "user_video_frame";
      readonly role: VoxTransportRole;
      readonly userId: string;
      readonly ssrc: number;
      readonly codec: string;
      readonly keyframe: boolean;
      readonly frameBase64: string;
      readonly rtpTimestamp: number;
      readonly streamType?: string;
      readonly rid?: string;
      readonly daveDecrypted: boolean;
    }
  | ({ readonly type: "decoded_video_frame" } & VoxDecodedVideoFrame)
  | { readonly type: "client_disconnect"; readonly userId: string }
  | { readonly type: "music_idle"; readonly musicId: string }
  | {
      readonly type: "music_error";
      readonly musicId: string;
      readonly code: VoxMusicErrorCode;
      readonly message: string;
    }
  | { readonly type: "music_gain_reached"; readonly musicId: string; readonly gain: number }
  | {
      readonly type: "stream_publish_media_started";
      readonly role: "stream_publish";
      readonly connectionGeneration: number;
      readonly sourceGeneration: number;
    }
  | VoxTransportError
  | {
      readonly type: "error";
      readonly code: "invalid_request" | "invalid_json" | "input_too_large";
      readonly message: string;
      readonly role?: never;
      readonly connectionId?: never;
    }
  | { readonly type: "buffer_depth"; readonly ttsSamples: number; readonly musicSamples: number }
  | {
      readonly type: "transport_stats";
      readonly uptimeMs: number;
      readonly tick: Readonly<Record<string, number>>;
      readonly ipcLanes: Readonly<Record<string, number>>;
      readonly inboundAudio?: Readonly<Record<string, number>>;
      readonly inboundVideo: Readonly<Record<string, number>>;
      readonly outbound: Readonly<Record<string, number>>;
    }
  | {
      readonly type: "tts_buffer_overflow";
      readonly playbackId: string;
      readonly droppedSamples: number;
      readonly droppedMs: number;
      readonly bufferSamples: number;
      readonly bufferMs: number;
    };

export interface VoxTtsAudio {
  readonly playbackId: string;
  readonly pcmBase64: string;
  readonly sampleRate?: number;
}

export interface VoxMusicRequest {
  readonly musicId: string;
  readonly url: string;
  readonly resolvedDirectUrl?: boolean;
}

export interface VoxStreamConnect {
  readonly endpoint: string;
  readonly token: string;
  readonly serverId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly daveChannelId: string;
}

/** The bounded stream surface consumed by the Discord user-session body. */
export interface VoxStreamClient {
  readonly available: boolean;
  readonly status: VoxProcessStatus;
  readonly detail: string;
  streamWatchConnect(input: VoxStreamConnect): void;
  streamWatchDisconnect(reason?: string): void;
  subscribeUserVideo(userId: string, maxFramesPerSecond?: number): void;
  unsubscribeUserVideo(userId: string): void;
  streamPublishConnect(input: VoxStreamConnect): void;
  streamPublishDisconnect(reason?: string): void;
  streamPublishPlay(url: string): void;
  streamPublishBrowserStart(mimeType?: "image/png"): void;
  streamPublishBrowserFrame(input: {
    mimeType: "image/png";
    frameBase64: string;
    capturedAtMs?: number;
  }): void;
  streamPublishStop(): void;
  streamPublishPause(): void;
  streamPublishResume(): void;
  onStatus(listener: (status: VoxProcessStatus, detail: string) => void): VoxListenerRegistration;
  onEvent(listener: (event: VoxControlEvent) => void): VoxListenerRegistration;
  onDecodedFrame(listener: (frame: VoxDecodedVideoFrame) => void): VoxListenerRegistration;
  close(): void;
}

/** Full deterministic media-plane contract implemented by the Rust process. */
export interface VoxClient extends VoxStreamClient {
  onStatus(listener: (status: VoxProcessStatus, detail: string) => void): VoxUnsubscribe;
  onEvent(listener: (event: VoxControlEvent) => void): VoxUnsubscribe;
  onDecodedFrame(listener: (frame: VoxDecodedVideoFrame) => void): VoxUnsubscribe;
  joinVoice(input: { connectionId: string; guildId: string; channelId: string; selfMute?: boolean }): void;
  leaveVoice(reason?: string): void;
  updateVoiceServer(data: { endpoint: string | null; token: string | null }): void;
  updateVoiceState(data: {
    session_id?: string | null;
    user_id?: string | null;
    channel_id?: string | null;
  }): void;
  sendAudio(input: VoxTtsAudio): void;
  stopPlayback(): void;
  finishTtsPlayback(playbackId: string): void;
  stopTtsPlayback(playbackId: string): void;
  subscribeUserAudio(
    userId: string,
    captureId: string,
    options?: { silenceDurationMs?: number; sampleRate?: number },
  ): void;
  unsubscribeUserAudio(userId: string): void;
  musicPlay(input: VoxMusicRequest): void;
  musicStop(musicId: string): void;
  musicPause(musicId: string): void;
  musicResume(musicId: string): void;
  musicSetGain(musicId: string, target: number, fadeMs?: number): void;
  onUserAudio(listener: (frame: VoxUserAudioFrame) => void): VoxUnsubscribe;
}

export function resolveVoxBin(
  env: NodeJS.ProcessEnv = process.env,
  candidates: readonly string[] = defaultVoxBinCandidates(),
): string | undefined {
  const configured = env.CLANKIE_VOX_BIN?.trim();
  if (configured !== undefined) return existsSync(configured) ? configured : undefined;
  return candidates.find((candidate) => existsSync(candidate));
}

export function defaultVoxRoot(): string {
  return fileURLToPath(new URL("../../../apps/vox", import.meta.url));
}

export function defaultVoxBinCandidates(voxRoot: string = defaultVoxRoot()): readonly string[] {
  return [join(voxRoot, "target", "release", "clankvox"), join(voxRoot, "target", "debug", "clankvox")];
}

/** Build inputs whose mtime should never exceed the binary's. */
const VOX_BUILD_INPUTS = ["src", "Cargo.toml", "Cargo.lock"] as const;

/** Newest mtime at `path`, walking into it when it is a directory. */
function newestMtimeMs(path: string): number | undefined {
  let root;
  try {
    root = statSync(path);
  } catch {
    return undefined;
  }
  if (!root.isDirectory()) return root.mtimeMs;
  let newest = root.mtimeMs;
  for (const entry of readdirSync(path, { recursive: true, encoding: "utf8" })) {
    try {
      const at = statSync(join(path, entry)).mtimeMs;
      if (at > newest) newest = at;
    } catch {
      // A file that vanished mid-walk cannot be newer than a build that already exists.
    }
  }
  return newest;
}

/**
 * Explain a Vox binary that predates its own source, when it does.
 *
 * Nothing rebuilds this binary automatically, so editing `apps/vox` and
 * restarting a body silently runs the previous build against the current
 * client. Version drift then surfaces at the one place the two halves agree on
 * a contract — the IPC handshake — and reads as a protocol bug. On 2026-08-21 a
 * binary six days older than the commit that dropped Vox's stdout log layer
 * failed with "Vox emitted log before the protocol handshake", which sent the
 * search into the frame decoder rather than into `cargo build`.
 *
 * Judges only this repo's own build output. A `CLANKIE_VOX_BIN` pointing
 * anywhere else is the operator's own build, and `apps/vox` says nothing about
 * how current it is. Returns undefined for such a binary, for one already at
 * least as new as every input, and when the source tree is absent — a packaged
 * install ships the binary with nothing to compare against.
 */
export function voxBuildStaleHint(bin: string, voxRoot: string = defaultVoxRoot()): string | undefined {
  const owned = defaultVoxBinCandidates(voxRoot).some((candidate) => resolve(candidate) === resolve(bin));
  if (!owned) return undefined;
  const built = newestMtimeMs(bin);
  if (built === undefined) return undefined;
  let newestInput: number | undefined;
  for (const input of VOX_BUILD_INPUTS) {
    const at = newestMtimeMs(join(voxRoot, input));
    if (at !== undefined && (newestInput === undefined || at > newestInput)) newestInput = at;
  }
  if (newestInput === undefined || built >= newestInput) return undefined;
  return "the Vox binary predates apps/vox — run `pnpm --filter @clankie/vox build`";
}

export function createVoxClient(
  options: {
    bin?: string;
    env?: NodeJS.ProcessEnv;
    onError?: (message: string) => void;
    onLog?: (message: string) => void;
  } = {},
): VoxClient {
  const bin = options.bin ?? resolveVoxBin(options.env);
  if (bin === undefined || !existsSync(bin)) {
    return missingClient(
      "Vox binary not found. Run `pnpm --filter @clankie/vox build` or set CLANKIE_VOX_BIN.",
    );
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    return missingClient(error instanceof Error ? error.message : "failed to spawn Vox");
  }

  const eventListeners = new Set<(event: VoxControlEvent) => void>();
  const statusListeners = new Set<(status: VoxProcessStatus, detail: string) => void>();
  const audioListeners = new Set<(frame: VoxUserAudioFrame) => void>();
  const decodedFrameListeners = new Set<(frame: VoxDecodedVideoFrame) => void>();
  const activeCaptureIds = new Map<string, string>();
  const decoder = new VoxFrameDecoder();
  const stderrDecoder = new VoxStderrDecoder();
  let status: VoxProcessStatus = "starting";
  let detail = bin;
  let closeRequested = false;
  let terminalError = false;
  let handshakeComplete = false;
  let stdinBlocked = false;
  const queuedControlCommands: { line: string; correlationId?: string }[] = [];
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let handshakeTimer: ReturnType<typeof setTimeout> | undefined;

  const setStatus = (next: VoxProcessStatus, nextDetail = detail): void => {
    status = next;
    detail = nextDetail;
    for (const listener of statusListeners) listener(status, detail);
  };

  const failClient = (
    code: VoxClientErrorCode,
    message: string,
    correlationId?: string,
    terminate = true,
  ): VoxClientError => {
    // Every pre-handshake failure has the same cheap first suspect, so name it
    // here rather than at each fault site.
    const stale = handshakeComplete ? undefined : voxBuildStaleHint(bin);
    const reported = stale === undefined ? message : `${message} — ${stale}`;
    const error = new VoxClientError(code, reported, correlationId);
    if (!terminalError) {
      terminalError = true;
      if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
      queuedControlCommands.length = 0;
      setStatus("error", reported);
      options.onError?.(reported);
      if (terminate && child.exitCode === null && !child.killed) child.kill("SIGTERM");
    }
    return error;
  };

  child.once("error", (error) => {
    failClient("stdin_write_failed", error.message, undefined, false);
  });
  child.once("exit", (code, signal) => {
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
    if (closeRequested) return setStatus("closed", "Vox closed");
    if (terminalError) return;
    const message = `Vox exited unexpectedly (${signal ?? code ?? "unknown"})`;
    failClient("stdin_write_failed", message, undefined, false);
  });
  child.stdin.on("error", (error) => {
    if (closeRequested || terminalError) return;
    failClient("stdin_write_failed", error.message, undefined, false);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    const result = decoder.push(chunk);
    if (result.fault !== undefined) {
      failClient("protocol_mismatch", result.fault);
      return;
    }
    for (const frame of result.frames) {
      if (frame.format === 0) {
        const rawEvent = decodeVoxControlRecord(frame.payload);
        if (rawEvent?.type === "process_ready") {
          if (typeof rawEvent.protocolVersion !== "number") {
            failClient("protocol_missing", "Vox binary did not provide the mandatory IPC protocol version");
            continue;
          }
          if (rawEvent.protocolVersion !== VOX_IPC_PROTOCOL_VERSION) {
            failClient(
              "protocol_mismatch",
              `Vox IPC protocol mismatch: client=${VOX_IPC_PROTOCOL_VERSION} binary=${rawEvent.protocolVersion}`,
            );
            continue;
          }
          if (!handshakeComplete) {
            handshakeComplete = true;
            if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
            setStatus("ready", bin);
          }
        } else if (!handshakeComplete) {
          failClient(
            "protocol_missing",
            `Vox emitted ${typeof rawEvent?.type === "string" ? rawEvent.type : "an invalid event"} before the protocol handshake`,
          );
          continue;
        }
        const event = decodeVoxControlEvent(frame.payload);
        if (event === undefined) continue;
        if (
          (event.type === "speaking_start" ||
            event.type === "speaking_end" ||
            event.type === "user_audio_end") &&
          event.captureId !== undefined &&
          activeCaptureIds.get(event.userId) !== event.captureId
        ) {
          continue;
        }
        if (event.type === "user_audio_end") activeCaptureIds.delete(event.userId);
        for (const listener of eventListeners) listener(event);
        if (event.type === "error" && typeof event.message === "string") {
          options.onError?.(sanitizeVoxLog(event.message));
        }
        const decoded = decodeVoxVideoFrame(event);
        if (decoded !== undefined) {
          for (const listener of decodedFrameListeners) listener(decoded);
        }
        continue;
      }
      if (!handshakeComplete) {
        failClient("protocol_missing", "Vox emitted audio before the protocol handshake");
        continue;
      }
      const audio = decodeVoxUserAudio(frame.payload);
      if (audio !== undefined) {
        try {
          if (activeCaptureIds.get(audio.userId) === audio.captureId) {
            for (const listener of audioListeners) {
              listener({ ...audio, pcm: audio.pcm.slice() });
            }
          }
        } finally {
          audio.pcm.fill(0);
        }
      }
    }
  });
  child.stderr.setEncoding("utf8");
  const emitStderrLine = (line: string): void => {
    const trimmed = sanitizeVoxLog(line.trim());
    if (trimmed.length > 0) options.onLog?.(trimmed.slice(0, 400));
  };
  child.stderr.on("data", (chunk: string) => {
    for (const line of stderrDecoder.push(chunk)) emitStderrLine(line);
  });
  child.stderr.on("end", () => {
    const line = stderrDecoder.finish();
    if (line !== undefined) emitStderrLine(line);
  });

  handshakeTimer = setTimeout(() => {
    if (!handshakeComplete && !closeRequested) {
      failClient("protocol_missing", "Vox did not complete the IPC protocol handshake");
    }
  }, PROCESS_READY_TIMEOUT_MS);
  handshakeTimer.unref();

  const writeNow = (line: string, correlationId?: string): void => {
    try {
      if (!child.stdin.write(line)) {
        stdinBlocked = true;
        child.stdin.once("drain", flushQueuedControlCommands);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Vox stdin write failed";
      throw failClient("stdin_write_failed", message, correlationId);
    }
  };

  function flushQueuedControlCommands(): void {
    stdinBlocked = false;
    while (!stdinBlocked && queuedControlCommands.length > 0) {
      const command = queuedControlCommands.shift();
      if (command === undefined) continue;
      try {
        writeNow(command.line, command.correlationId);
      } catch {
        return;
      }
    }
  }

  const send = (
    command: Record<string, unknown>,
    delivery: "reliable" | "lossy" = "reliable",
    correlationId?: string,
  ): void => {
    if (status !== "ready" || !handshakeComplete) {
      throw new VoxClientError(
        status === "closed" ? "closed" : "not_ready",
        `Vox is not ready (${status}): ${detail}`,
        correlationId,
      );
    }
    if (closeRequested || child.killed || child.exitCode !== null) {
      throw new VoxClientError("closed", "Vox is closed", correlationId);
    }
    const line = `${JSON.stringify(command)}\n`;
    if (Buffer.byteLength(line) > MAX_STDIN_LINE_BYTES) {
      throw failClient("input_too_large", "Vox command exceeds the bounded IPC payload", correlationId);
    }
    if (!stdinBlocked) {
      writeNow(line, correlationId);
      return;
    }
    if (delivery === "lossy") return;
    if (queuedControlCommands.length >= MAX_QUEUED_CONTROL_COMMANDS) {
      throw failClient(
        "stdin_queue_overflow",
        "Vox reliable input queue is full while stdin is backpressured",
        correlationId,
      );
    }
    queuedControlCommands.push({
      line,
      ...(correlationId === undefined ? {} : { correlationId }),
    });
  };

  return {
    get available() {
      return status === "ready";
    },
    get status() {
      return status;
    },
    get detail() {
      return detail;
    },
    joinVoice(input) {
      send({
        type: "join",
        connectionId: input.connectionId,
        guildId: input.guildId,
        channelId: input.channelId,
        selfMute: input.selfMute ?? false,
      });
    },
    leaveVoice(reason) {
      activeCaptureIds.clear();
      send({ type: "leave", reason: reason ?? null });
    },
    updateVoiceServer(data) {
      send({ type: "voice_server", data });
    },
    updateVoiceState(data) {
      send({ type: "voice_state", data });
    },
    sendAudio(input) {
      send(
        {
          type: "audio",
          playbackId: input.playbackId,
          pcmBase64: input.pcmBase64,
          sampleRate: input.sampleRate ?? 24_000,
        },
        "reliable",
        input.playbackId,
      );
    },
    stopPlayback() {
      send({ type: "stop_playback" });
    },
    finishTtsPlayback(playbackId) {
      send({ type: "finish_tts_playback", playbackId }, "reliable", playbackId);
    },
    stopTtsPlayback(playbackId) {
      send({ type: "stop_tts_playback", playbackId }, "reliable", playbackId);
    },
    subscribeUserAudio(userId, captureId, subscription = {}) {
      send({
        type: "subscribe_user",
        userId,
        captureId,
        silenceDurationMs: subscription.silenceDurationMs ?? 700,
        sampleRate: subscription.sampleRate ?? 24_000,
      });
      activeCaptureIds.set(userId, captureId);
    },
    unsubscribeUserAudio(userId) {
      activeCaptureIds.delete(userId);
      send({ type: "unsubscribe_user", userId });
    },
    streamWatchConnect(input) {
      send({ type: "stream_watch_connect", ...input });
    },
    streamWatchDisconnect(reason) {
      send({ type: "stream_watch_disconnect", reason: reason ?? null });
    },
    subscribeUserVideo(userId, maxFramesPerSecond = 1) {
      send({
        type: "subscribe_user_video",
        userId,
        maxFramesPerSecond,
        preferredQuality: 80,
        preferredPixelCount: null,
        preferredStreamType: "screen",
        jpegQuality: 70,
      });
    },
    unsubscribeUserVideo(userId) {
      send({ type: "unsubscribe_user_video", userId });
    },
    musicPlay(input) {
      send({
        type: "music_play",
        musicId: input.musicId,
        url: input.url.trim(),
        resolvedDirectUrl: input.resolvedDirectUrl ?? false,
      });
    },
    musicStop(musicId) {
      send({ type: "music_stop", musicId });
    },
    musicPause(musicId) {
      send({ type: "music_pause", musicId });
    },
    musicResume(musicId) {
      send({ type: "music_resume", musicId });
    },
    musicSetGain(musicId, target, fadeMs = 0) {
      send({ type: "music_set_gain", musicId, target, fadeMs });
    },
    streamPublishConnect(input) {
      send({ type: "stream_publish_connect", ...input });
    },
    streamPublishDisconnect(reason) {
      send({ type: "stream_publish_disconnect", reason: reason ?? null });
    },
    streamPublishPlay(url) {
      send({ type: "stream_publish_play", url: url.trim(), resolvedDirectUrl: false });
    },
    streamPublishBrowserStart(mimeType = BROWSER_FRAME_MIME_TYPE) {
      if (mimeType !== BROWSER_FRAME_MIME_TYPE) {
        options.onError?.("Vox browser publishing only supports image/png");
        return;
      }
      send({ type: "stream_publish_browser_start", mimeType: BROWSER_FRAME_MIME_TYPE });
    },
    streamPublishBrowserFrame(input) {
      if (input.mimeType !== BROWSER_FRAME_MIME_TYPE) {
        options.onError?.("Vox browser publishing only supports image/png");
        return;
      }
      if (input.frameBase64.length > MAX_BROWSER_FRAME_BASE64_BYTES) {
        options.onError?.("Vox browser frame exceeds the bounded IPC payload");
        return;
      }
      send(
        {
          type: "stream_publish_browser_frame",
          mimeType: BROWSER_FRAME_MIME_TYPE,
          frameBase64: input.frameBase64,
          capturedAtMs: input.capturedAtMs ?? Date.now(),
        },
        "lossy",
      );
    },
    streamPublishStop() {
      send({ type: "stream_publish_stop" });
    },
    streamPublishPause() {
      send({ type: "stream_publish_pause" });
    },
    streamPublishResume() {
      send({ type: "stream_publish_resume" });
    },
    onStatus(listener) {
      statusListeners.add(listener);
      listener(status, detail);
      return () => statusListeners.delete(listener);
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onUserAudio(listener) {
      audioListeners.add(listener);
      return () => audioListeners.delete(listener);
    },
    onDecodedFrame(listener) {
      decodedFrameListeners.add(listener);
      return () => decodedFrameListeners.delete(listener);
    },
    close() {
      if (closeRequested) return;
      closeRequested = true;
      if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
      queuedControlCommands.length = 0;
      child.stdin.end(`${JSON.stringify({ type: "destroy" })}\n`);
      closeTimer = setTimeout(() => {
        if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      }, GRACEFUL_CLOSE_TIMEOUT_MS);
      closeTimer.unref();
    },
  };
}

function missingClient(detail: string): VoxClient {
  const unavailable = (correlationId?: string): never => {
    throw new VoxClientError("not_ready", detail, correlationId);
  };
  return {
    available: false,
    status: "missing",
    detail,
    joinVoice() {
      unavailable();
    },
    leaveVoice() {
      unavailable();
    },
    updateVoiceServer() {
      unavailable();
    },
    updateVoiceState() {
      unavailable();
    },
    sendAudio(input) {
      unavailable(input.playbackId);
    },
    stopPlayback() {
      unavailable();
    },
    finishTtsPlayback(playbackId) {
      unavailable(playbackId);
    },
    stopTtsPlayback(playbackId) {
      unavailable(playbackId);
    },
    subscribeUserAudio() {
      unavailable();
    },
    unsubscribeUserAudio() {
      unavailable();
    },
    streamWatchConnect() {
      unavailable();
    },
    streamWatchDisconnect() {
      unavailable();
    },
    subscribeUserVideo() {
      unavailable();
    },
    unsubscribeUserVideo() {
      unavailable();
    },
    musicPlay() {
      unavailable();
    },
    musicStop() {
      unavailable();
    },
    musicPause() {
      unavailable();
    },
    musicResume() {
      unavailable();
    },
    musicSetGain() {
      unavailable();
    },
    streamPublishConnect() {
      unavailable();
    },
    streamPublishDisconnect() {
      unavailable();
    },
    streamPublishPlay() {
      unavailable();
    },
    streamPublishBrowserStart() {
      unavailable();
    },
    streamPublishBrowserFrame() {
      unavailable();
    },
    streamPublishStop() {
      unavailable();
    },
    streamPublishPause() {
      unavailable();
    },
    streamPublishResume() {
      unavailable();
    },
    onStatus(listener) {
      listener("missing", detail);
      return () => {};
    },
    onEvent() {
      return () => {};
    },
    onUserAudio() {
      return () => {};
    },
    onDecodedFrame() {
      return () => {};
    },
    close() {},
  };
}

export function sanitizeVoxLog(message: string): string {
  return message
    .replace(/\b(?:https?|wss?):\/\/[^\s"'`]+/giu, "[redacted-url]")
    .replace(
      /\b(token|session[_-]?id|media_session_id|endpoint)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/giu,
      "$1$2[redacted]",
    );
}

export class VoxStderrDecoder {
  private buffer = "";

  public push(chunk: string): string[] {
    const lines = `${this.buffer}${chunk}`.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.map((line) => line.replace(/\r$/u, ""));
  }

  public finish(): string | undefined {
    if (this.buffer.length === 0) return undefined;
    const line = this.buffer.replace(/\r$/u, "");
    this.buffer = "";
    return line;
  }
}

export class VoxFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private faulted = false;

  public push(chunk: Uint8Array): { frames: { format: number; payload: Buffer }[]; fault?: string } {
    if (this.faulted) {
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).fill(0);
      return { frames: [] };
    }
    const incoming = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    incoming.fill(0);
    const frames: { format: number; payload: Buffer }[] = [];
    while (this.buffer.length >= FRAME_HEADER_BYTES) {
      const format = this.buffer.readUInt8(0);
      const length = this.buffer.readUInt32LE(1);
      if (format !== 0 && format !== 1) {
        this.faulted = true;
        const fault = `unknown Vox frame format ${format}`;
        this.buffer.fill(0);
        this.buffer = Buffer.alloc(0);
        return { frames: [], fault };
      }
      if (length > MAX_FRAME_BYTES) {
        this.faulted = true;
        const fault = `Vox frame length ${length} exceeds cap`;
        this.buffer.fill(0);
        this.buffer = Buffer.alloc(0);
        return { frames: [], fault };
      }
      if (this.buffer.length < FRAME_HEADER_BYTES + length) break;
      frames.push({
        format,
        payload: this.buffer.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length),
      });
      this.buffer = this.buffer.subarray(FRAME_HEADER_BYTES + length);
    }
    return { frames };
  }
}

export function decodeVoxControlEvent(payload: Uint8Array): VoxControlEvent | undefined {
  try {
    const value = JSON.parse(Buffer.from(payload).toString("utf8")) as unknown;
    if (!isRecord(value) || typeof value.type !== "string") return undefined;
    const string = (key: string): boolean => typeof value[key] === "string";
    const number = (key: string): boolean => typeof value[key] === "number";
    const optionalString = (key: string): boolean => value[key] === undefined || string(key);
    const role = (): boolean =>
      value.role === "voice" || value.role === "stream_watch" || value.role === "stream_publish";
    const transportScope = (): boolean =>
      role() && (value.role === "voice" ? string("connectionId") : value.connectionId === undefined);
    const transportErrorScope = (): boolean => {
      switch (value.code) {
        case "voice_connect_failed":
          return value.role === "voice" && string("connectionId");
        case "stream_watch_connect_failed":
          return value.role === "stream_watch" && value.connectionId === undefined;
        case "stream_publish_connect_failed":
          return value.role === "stream_publish" && value.connectionId === undefined;
        case "voice_runtime_error":
          return transportScope();
        default:
          return false;
      }
    };
    let valid = false;
    switch (value.type) {
      case "process_ready":
        valid = number("protocolVersion");
        break;
      case "ready":
        valid = string("connectionId");
        break;
      case "adapter_send":
        valid = "payload" in value;
        break;
      case "connection_state":
        valid = string("status") && string("connectionId");
        break;
      case "transport_state":
        valid = transportScope() && string("status") && optionalString("reason");
        break;
      case "dave_state":
        valid =
          transportScope() &&
          (value.status === "negotiating" ||
            value.status === "ready" ||
            value.status === "disabled" ||
            value.status === "cleared") &&
          (value.protocolVersion === undefined || number("protocolVersion"));
        break;
      case "player_state":
        valid = string("status") && optionalString("musicId");
        break;
      case "playback_armed":
        valid = string("reason");
        break;
      case "tts_playback_state":
        valid =
          string("playbackId") &&
          (value.status === "buffered" ||
            value.status === "started" ||
            value.status === "drained" ||
            value.status === "stopped" ||
            value.status === "failed") &&
          optionalString("reason");
        break;
      case "speaking_start":
      case "speaking_end":
        valid = string("userId") && optionalString("captureId");
        break;
      case "user_audio_end":
        valid = string("userId") && string("captureId");
        break;
      case "user_video_frame":
        valid =
          role() &&
          string("userId") &&
          number("ssrc") &&
          string("codec") &&
          typeof value.keyframe === "boolean" &&
          string("frameBase64") &&
          number("rtpTimestamp") &&
          optionalString("streamType") &&
          optionalString("rid") &&
          typeof value.daveDecrypted === "boolean";
        break;
      case "decoded_video_frame":
        valid = role() && string("userId") && number("width") && number("height") && string("jpegBase64");
        break;
      case "client_disconnect":
        valid = string("userId");
        break;
      case "music_idle":
        valid = string("musicId");
        break;
      case "music_error":
        valid =
          string("musicId") &&
          (value.code === "http_403" ||
            value.code === "format_unavailable" ||
            value.code === "spawn_failed" ||
            value.code === "missing_stdout" ||
            value.code === "no_audio" ||
            value.code === "pipeline_failed" ||
            value.code === "wait_failed") &&
          string("message");
        break;
      case "music_gain_reached":
        valid = string("musicId") && number("gain");
        break;
      case "stream_publish_media_started":
        valid =
          value.role === "stream_publish" && number("connectionGeneration") && number("sourceGeneration");
        break;
      case "error":
        valid =
          string("message") &&
          (value.code === "invalid_request" ||
          value.code === "invalid_json" ||
          value.code === "input_too_large"
            ? value.role === undefined && value.connectionId === undefined
            : transportErrorScope());
        break;
      case "buffer_depth":
        valid = number("ttsSamples") && number("musicSamples");
        break;
      case "transport_stats":
        valid =
          number("uptimeMs") &&
          isNumberRecord(value.tick) &&
          isNumberRecord(value.ipcLanes) &&
          (value.inboundAudio === undefined || isNumberRecord(value.inboundAudio)) &&
          isNumberRecord(value.inboundVideo) &&
          isNumberRecord(value.outbound);
        break;
      case "tts_buffer_overflow":
        valid =
          string("playbackId") &&
          number("droppedSamples") &&
          number("droppedMs") &&
          number("bufferSamples") &&
          number("bufferMs");
        break;
    }
    return valid ? (value as VoxControlEvent) : undefined;
  } catch {
    return undefined;
  }
}

function decodeVoxControlRecord(payload: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(Buffer.from(payload).toString("utf8")) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "number");
}

export function decodeVoxVideoFrame(event: VoxControlEvent): VoxDecodedVideoFrame | undefined {
  if (event.type !== "decoded_video_frame") return undefined;
  if (typeof event.userId !== "string" || typeof event.jpegBase64 !== "string") return undefined;
  if (typeof event.width !== "number" || typeof event.height !== "number") return undefined;
  if (event.jpegBase64.length === 0) return undefined;
  return {
    role: event.role,
    userId: event.userId,
    width: event.width,
    height: event.height,
    jpegBase64: event.jpegBase64,
  };
}

export function decodeVoxUserAudio(payload: Uint8Array): VoxUserAudioFrame | undefined {
  const frame = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  try {
    if (frame.byteLength < USER_AUDIO_HEADER_BYTES) return undefined;
    const signalActiveSampleCount = frame.readUInt32LE(10);
    const signalSampleCount = frame.readUInt32LE(14);
    const captureIdBytes = frame.readUInt16LE(18);
    if (signalActiveSampleCount > signalSampleCount) return undefined;
    const pcmOffset = USER_AUDIO_HEADER_BYTES + captureIdBytes;
    if (frame.byteLength - pcmOffset !== signalSampleCount * 2) return undefined;
    let captureId: string;
    try {
      captureId = new TextDecoder("utf-8", { fatal: true }).decode(
        frame.subarray(USER_AUDIO_HEADER_BYTES, pcmOffset),
      );
    } catch {
      return undefined;
    }
    if (captureId.length === 0) return undefined;
    return {
      userId: frame.readBigUInt64LE(0).toString(),
      captureId,
      signalPeakAbs: frame.readUInt16LE(8),
      signalActiveSampleCount,
      signalSampleCount,
      pcm: Uint8Array.from(frame.subarray(pcmOffset)),
    };
  } finally {
    frame.fill(0);
  }
}
