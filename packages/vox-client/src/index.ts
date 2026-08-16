import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const FRAME_HEADER_BYTES = 5;
const USER_AUDIO_HEADER_BYTES = 18;
const MAX_STDIN_LINE_BYTES = 8 * 1024 * 1024;
const MAX_BROWSER_FRAME_BASE64_BYTES = 7_500_000;
const MAX_QUEUED_CONTROL_COMMANDS = 256;
const GRACEFUL_CLOSE_TIMEOUT_MS = 2_000;

export type VoxProcessStatus = "missing" | "starting" | "ready" | "error" | "closed";

export interface VoxDecodedVideoFrame {
  readonly userId: string;
  readonly width: number;
  readonly height: number;
  readonly jpegBase64: string;
}

export interface VoxUserAudioFrame {
  readonly userId: string;
  readonly signalPeakAbs: number;
  readonly signalActiveSampleCount: number;
  readonly signalSampleCount: number;
  readonly pcm: Uint8Array;
}

export interface VoxControlEvent extends Record<string, unknown> {
  readonly type: string;
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
  streamPublishBrowserStart(mimeType?: string): void;
  streamPublishBrowserFrame(input: { mimeType: string; frameBase64: string; capturedAtMs?: number }): void;
  streamPublishStop(): void;
  streamPublishPause(): void;
  streamPublishResume(): void;
  onStatus(listener: (status: VoxProcessStatus, detail: string) => void): void;
  onEvent(listener: (event: VoxControlEvent) => void): void;
  onDecodedFrame(listener: (frame: VoxDecodedVideoFrame) => void): void;
  close(): void;
}

/** Full deterministic media-plane contract implemented by the Rust process. */
export interface VoxClient extends VoxStreamClient {
  joinVoice(input: { guildId: string; channelId: string; selfMute?: boolean }): void;
  updateVoiceServer(data: { endpoint: string | null; token: string | null }): void;
  updateVoiceState(data: {
    session_id?: string | null;
    user_id?: string | null;
    channel_id?: string | null;
  }): void;
  sendAudio(input: { pcmBase64: string; sampleRate?: number }): void;
  stopPlayback(): void;
  stopTtsPlayback(): void;
  subscribeUserAudio(userId: string, options?: { silenceDurationMs?: number; sampleRate?: number }): void;
  unsubscribeUserAudio(userId: string): void;
  musicPlay(url: string, resolvedDirectUrl?: boolean): void;
  musicStop(): void;
  musicPause(): void;
  musicResume(): void;
  musicSetGain(target: number, fadeMs?: number): void;
  streamPublishPlayVisualizer(url: string, visualizerMode?: string): void;
  onUserAudio(listener: (frame: VoxUserAudioFrame) => void): void;
}

export function resolveVoxBin(
  env: NodeJS.ProcessEnv = process.env,
  candidates: readonly string[] = defaultVoxBinCandidates(),
): string | undefined {
  const configured = env.CLANKIE_VOX_BIN?.trim() || env.CLANKVOX_BIN?.trim();
  if (configured !== undefined) return existsSync(configured) ? configured : undefined;
  return candidates.find((candidate) => existsSync(candidate));
}

export function defaultVoxBinCandidates(): readonly string[] {
  const voxRoot = fileURLToPath(new URL("../../../apps/vox", import.meta.url));
  return [
    join(voxRoot, "target", "release", "clankvox"),
    join(voxRoot, "target", "debug", "clankvox"),
    join(homedir(), ".clankie", "bin", "clankvox"),
  ];
}

export function createVoxClient(
  options: {
    bin?: string;
    env?: NodeJS.ProcessEnv;
    onError?: (message: string) => void;
    onLog?: (message: string) => void;
    onEvent?: (event: VoxControlEvent) => void;
    onStatus?: (status: VoxProcessStatus, detail: string) => void;
    onUserAudio?: (frame: VoxUserAudioFrame) => void;
    onDecodedFrame?: (frame: VoxDecodedVideoFrame) => void;
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
  const decoder = new VoxFrameDecoder();
  let status: VoxProcessStatus = "starting";
  let detail = bin;
  let closeRequested = false;
  let stdinBlocked = false;
  const queuedControlCommands: string[] = [];
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  if (options.onEvent !== undefined) eventListeners.add(options.onEvent);
  if (options.onStatus !== undefined) statusListeners.add(options.onStatus);
  if (options.onUserAudio !== undefined) audioListeners.add(options.onUserAudio);
  if (options.onDecodedFrame !== undefined) decodedFrameListeners.add(options.onDecodedFrame);

  const setStatus = (next: VoxProcessStatus, nextDetail = detail): void => {
    status = next;
    detail = nextDetail;
    for (const listener of statusListeners) listener(status, detail);
  };

  child.once("error", (error) => {
    setStatus("error", error.message);
    options.onError?.(error.message);
  });
  child.once("exit", (code, signal) => {
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    if (closeRequested) return setStatus("closed", "Vox closed");
    const message = `Vox exited unexpectedly (${signal ?? code ?? "unknown"})`;
    setStatus("error", message);
    options.onError?.(message);
  });
  child.stdin.on("error", (error) => {
    if (closeRequested) return;
    setStatus("error", error.message);
    options.onError?.(error.message);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    const result = decoder.push(chunk);
    if (result.fault !== undefined) {
      setStatus("error", result.fault);
      options.onError?.(result.fault);
      return;
    }
    for (const frame of result.frames) {
      if (frame.format === 0) {
        const event = decodeVoxControlEvent(frame.payload);
        if (event === undefined) continue;
        if (event.type === "process_ready") setStatus("ready", bin);
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
      const audio = decodeVoxUserAudio(frame.payload);
      if (audio !== undefined) {
        for (const listener of audioListeners) listener(audio);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (line: string) => {
    const trimmed = sanitizeVoxLog(line.trim());
    if (trimmed.length > 0) options.onLog?.(trimmed.slice(0, 400));
  });

  const writeNow = (line: string): boolean => {
    try {
      if (!child.stdin.write(line)) {
        stdinBlocked = true;
        child.stdin.once("drain", flushQueuedControlCommands);
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Vox stdin write failed";
      setStatus("error", message);
      options.onError?.(message);
      return false;
    }
  };

  function flushQueuedControlCommands(): void {
    stdinBlocked = false;
    while (!stdinBlocked && queuedControlCommands.length > 0) {
      const line = queuedControlCommands.shift();
      if (line !== undefined && !writeNow(line)) queuedControlCommands.length = 0;
    }
  }

  const send = (command: Record<string, unknown>, delivery: "reliable" | "lossy" = "reliable"): void => {
    if (closeRequested || child.killed || child.exitCode !== null) return;
    const line = `${JSON.stringify(command)}\n`;
    if (Buffer.byteLength(line) > MAX_STDIN_LINE_BYTES) {
      options.onError?.("Vox command exceeds the bounded IPC payload");
      return;
    }
    if (!stdinBlocked) {
      writeNow(line);
      return;
    }
    if (delivery === "lossy") return;
    if (queuedControlCommands.length >= MAX_QUEUED_CONTROL_COMMANDS) {
      options.onError?.("Vox control queue is full while stdin is backpressured");
      return;
    }
    queuedControlCommands.push(line);
  };

  return {
    available: true,
    get status() {
      return status;
    },
    get detail() {
      return detail;
    },
    joinVoice(input) {
      send({
        type: "join",
        guildId: input.guildId,
        channelId: input.channelId,
        selfMute: input.selfMute ?? false,
      });
    },
    updateVoiceServer(data) {
      send({ type: "voice_server", data });
    },
    updateVoiceState(data) {
      send({ type: "voice_state", data });
    },
    sendAudio(input) {
      send({ type: "audio", pcmBase64: input.pcmBase64, sampleRate: input.sampleRate ?? 24_000 }, "lossy");
    },
    stopPlayback() {
      send({ type: "stop_playback" });
    },
    stopTtsPlayback() {
      send({ type: "stop_tts_playback" });
    },
    subscribeUserAudio(userId, subscription = {}) {
      send({
        type: "subscribe_user",
        userId,
        silenceDurationMs: subscription.silenceDurationMs ?? 700,
        sampleRate: subscription.sampleRate ?? 24_000,
      });
    },
    unsubscribeUserAudio(userId) {
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
    musicPlay(url, resolvedDirectUrl = false) {
      send({ type: "music_play", url: url.trim(), resolvedDirectUrl });
    },
    musicStop() {
      send({ type: "music_stop" });
    },
    musicPause() {
      send({ type: "music_pause" });
    },
    musicResume() {
      send({ type: "music_resume" });
    },
    musicSetGain(target, fadeMs = 0) {
      send({ type: "music_set_gain", target, fadeMs });
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
    streamPublishPlayVisualizer(url, visualizerMode = "cqt") {
      send({
        type: "stream_publish_play_visualizer",
        url: url.trim(),
        resolvedDirectUrl: false,
        visualizerMode,
      });
    },
    streamPublishBrowserStart(mimeType = "image/png") {
      send({ type: "stream_publish_browser_start", mimeType });
    },
    streamPublishBrowserFrame(input) {
      if (input.frameBase64.length > MAX_BROWSER_FRAME_BASE64_BYTES) {
        options.onError?.("Vox browser frame exceeds the bounded IPC payload");
        return;
      }
      send(
        {
          type: "stream_publish_browser_frame",
          mimeType: input.mimeType,
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
    },
    onEvent(listener) {
      eventListeners.add(listener);
    },
    onUserAudio(listener) {
      audioListeners.add(listener);
    },
    onDecodedFrame(listener) {
      decodedFrameListeners.add(listener);
    },
    close() {
      if (closeRequested) return;
      closeRequested = true;
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
  return {
    available: false,
    status: "missing",
    detail,
    joinVoice() {},
    updateVoiceServer() {},
    updateVoiceState() {},
    sendAudio() {},
    stopPlayback() {},
    stopTtsPlayback() {},
    subscribeUserAudio() {},
    unsubscribeUserAudio() {},
    streamWatchConnect() {},
    streamWatchDisconnect() {},
    subscribeUserVideo() {},
    unsubscribeUserVideo() {},
    musicPlay() {},
    musicStop() {},
    musicPause() {},
    musicResume() {},
    musicSetGain() {},
    streamPublishConnect() {},
    streamPublishDisconnect() {},
    streamPublishPlay() {},
    streamPublishPlayVisualizer() {},
    streamPublishBrowserStart() {},
    streamPublishBrowserFrame() {},
    streamPublishStop() {},
    streamPublishPause() {},
    streamPublishResume() {},
    onStatus(listener) {
      listener("missing", detail);
    },
    onEvent() {},
    onUserAudio() {},
    onDecodedFrame() {},
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

export class VoxFrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private faulted = false;

  public push(chunk: Uint8Array): { frames: { format: number; payload: Buffer }[]; fault?: string } {
    if (this.faulted) return { frames: [] };
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const frames: { format: number; payload: Buffer }[] = [];
    while (this.buffer.length >= FRAME_HEADER_BYTES) {
      const format = this.buffer.readUInt8(0);
      const length = this.buffer.readUInt32LE(1);
      if (format !== 0 && format !== 1) {
        this.faulted = true;
        return { frames, fault: `unknown Vox frame format ${format}` };
      }
      if (length > MAX_FRAME_BYTES) {
        this.faulted = true;
        return { frames, fault: `Vox frame length ${length} exceeds cap` };
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
    if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
    const type = (value as { type?: unknown }).type;
    return typeof type === "string" && type.length > 0 ? (value as VoxControlEvent) : undefined;
  } catch {
    return undefined;
  }
}

export function decodeVoxVideoFrame(event: VoxControlEvent): VoxDecodedVideoFrame | undefined {
  if (event.type !== "decoded_video_frame") return undefined;
  if (typeof event.userId !== "string" || typeof event.jpegBase64 !== "string") return undefined;
  if (typeof event.width !== "number" || typeof event.height !== "number") return undefined;
  if (event.jpegBase64.length === 0) return undefined;
  return {
    userId: event.userId,
    width: event.width,
    height: event.height,
    jpegBase64: event.jpegBase64,
  };
}

export function decodeVoxUserAudio(payload: Uint8Array): VoxUserAudioFrame | undefined {
  if (payload.byteLength < USER_AUDIO_HEADER_BYTES) return undefined;
  const frame = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const signalActiveSampleCount = frame.readUInt32LE(10);
  const signalSampleCount = frame.readUInt32LE(14);
  if (signalActiveSampleCount > signalSampleCount) return undefined;
  if (frame.byteLength - USER_AUDIO_HEADER_BYTES !== signalSampleCount * 2) return undefined;
  return {
    userId: frame.readBigUInt64LE(0).toString(),
    signalPeakAbs: frame.readUInt16LE(8),
    signalActiveSampleCount,
    signalSampleCount,
    pcm: frame.subarray(USER_AUDIO_HEADER_BYTES),
  };
}
