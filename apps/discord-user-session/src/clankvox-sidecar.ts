import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Apache-2.0 client for the AGPL ClankVox sidecar.
 *
 * This repository does not vendor ClankVox. Point `CLANKVOX_BIN` at a built
 * binary (or install one at `~/.clankie/bin/clankvox`). stdin is NDJSON;
 * stdout is the v1 framed protocol (u8 format, u32le length, JSON payload).
 */

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const HEADER_BYTES = 5;

export interface ClankvoxDecodedVideoFrame {
  readonly userId: string;
  readonly width: number;
  readonly height: number;
  readonly jpegBase64: string;
}

export interface ClankvoxStreamWatchConnect {
  readonly endpoint: string;
  readonly token: string;
  readonly serverId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly daveChannelId: string;
}

export interface ClankvoxSidecar {
  readonly available: boolean;
  readonly detail: string;
  streamWatchConnect(input: ClankvoxStreamWatchConnect): void;
  streamWatchDisconnect(reason?: string): void;
  subscribeUserVideo(userId: string, maxFramesPerSecond?: number): void;
  unsubscribeUserVideo(userId: string): void;
  streamPublishConnect(input: ClankvoxStreamWatchConnect): void;
  streamPublishDisconnect(reason?: string): void;
  streamPublishPlay(url: string): void;
  streamPublishBrowserStart(mimeType?: string): void;
  streamPublishBrowserFrame(input: { mimeType: string; frameBase64: string; capturedAtMs?: number }): void;
  streamPublishStop(): void;
  onDecodedFrame(listener: (frame: ClankvoxDecodedVideoFrame) => void): void;
  close(): void;
}

export function resolveClankvoxBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.CLANKVOX_BIN?.trim();
  if (configured !== undefined && configured.length > 0 && existsSync(configured)) return configured;
  const home = join(homedir(), ".clankie", "bin", "clankvox");
  if (existsSync(home)) return home;
  return undefined;
}

export function createClankvoxSidecar(
  options: {
    bin?: string;
    onError?: (message: string) => void;
  } = {},
): ClankvoxSidecar {
  const bin = options.bin ?? resolveClankvoxBin();
  if (bin === undefined) {
    return missingSidecar("ClankVox binary not found. Set CLANKVOX_BIN or install ~/.clankie/bin/clankvox.");
  }

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(bin, [], { stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    return missingSidecar(error instanceof Error ? error.message : "failed to spawn ClankVox");
  }

  const listeners = new Set<(frame: ClankvoxDecodedVideoFrame) => void>();
  const decoder = new FrameDecoder();
  child.stdout.on("data", (chunk: Buffer) => {
    const result = decoder.push(chunk);
    if (result.fault !== undefined) {
      options.onError?.(result.fault);
      return;
    }
    for (const frame of result.frames) {
      if (frame.format !== 0) continue;
      const parsed = parseDecodedFrame(frame.payload);
      if (parsed !== undefined) {
        for (const listener of listeners) listener(parsed);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (line: string) => {
    const trimmed = line.trim();
    if (trimmed.length > 0) options.onError?.(trimmed.slice(0, 400));
  });

  const send = (command: Record<string, unknown>): void => {
    if (child.killed || child.exitCode !== null) return;
    child.stdin.write(`${JSON.stringify(command)}\n`);
  };

  return {
    available: true,
    detail: bin,
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
    streamPublishConnect(input) {
      send({ type: "stream_publish_connect", ...input });
    },
    streamPublishDisconnect(reason) {
      send({ type: "stream_publish_disconnect", reason: reason ?? null });
    },
    streamPublishPlay(url) {
      send({ type: "stream_publish_play", url: url.trim(), resolvedDirectUrl: false });
    },
    streamPublishBrowserStart(mimeType = "image/png") {
      send({ type: "stream_publish_browser_start", mimeType });
    },
    streamPublishBrowserFrame(input) {
      send({
        type: "stream_publish_browser_frame",
        mimeType: input.mimeType,
        frameBase64: input.frameBase64,
        capturedAtMs: input.capturedAtMs ?? Date.now(),
      });
    },
    streamPublishStop() {
      send({ type: "stream_publish_stop" });
    },
    onDecodedFrame(listener) {
      listeners.add(listener);
    },
    close() {
      send({ type: "destroy" });
      child.kill("SIGTERM");
    },
  };
}

function missingSidecar(detail: string): ClankvoxSidecar {
  return {
    available: false,
    detail,
    streamWatchConnect() {},
    streamWatchDisconnect() {},
    subscribeUserVideo() {},
    unsubscribeUserVideo() {},
    streamPublishConnect() {},
    streamPublishDisconnect() {},
    streamPublishPlay() {},
    streamPublishBrowserStart() {},
    streamPublishBrowserFrame() {},
    streamPublishStop() {},
    onDecodedFrame() {},
    close() {},
  };
}

class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private faulted = false;

  push(chunk: Buffer): { frames: { format: number; payload: Buffer }[]; fault?: string } {
    if (this.faulted) return { frames: [] };
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const frames: { format: number; payload: Buffer }[] = [];
    while (this.buffer.length >= HEADER_BYTES) {
      const format = this.buffer.readUInt8(0);
      const length = this.buffer.readUInt32LE(1);
      if (format !== 0 && format !== 1) {
        this.faulted = true;
        return { frames, fault: `unknown ClankVox frame format ${format}` };
      }
      if (length > MAX_FRAME_BYTES) {
        this.faulted = true;
        return { frames, fault: `ClankVox frame length ${length} exceeds cap` };
      }
      if (this.buffer.length < HEADER_BYTES + length) break;
      frames.push({
        format,
        payload: this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + length),
      });
      this.buffer = this.buffer.subarray(HEADER_BYTES + length);
    }
    return { frames };
  }
}

function parseDecodedFrame(payload: Buffer): ClankvoxDecodedVideoFrame | undefined {
  try {
    const value = JSON.parse(payload.toString("utf8")) as Record<string, unknown>;
    if (value.type !== "decoded_video_frame") return undefined;
    if (typeof value.userId !== "string" || typeof value.jpegBase64 !== "string") return undefined;
    if (typeof value.width !== "number" || typeof value.height !== "number") return undefined;
    if (value.jpegBase64.length === 0) return undefined;
    return {
      userId: value.userId,
      width: value.width,
      height: value.height,
      jpegBase64: value.jpegBase64,
    };
  } catch {
    return undefined;
  }
}

export { FrameDecoder as ClankvoxFrameDecoder };
