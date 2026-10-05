import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ActivityShareFrameSchema, RENDERED_SURFACE_FRAME_MAX_BYTES } from "@clankie/interactive-environment";
import type { ActivityShareSink } from "@clankie/rendered-surface-client";
import type { ActivitySharingOptions } from "./activity-sharing.ts";
import type { DeliveredFileStore } from "./delivered-files.ts";

const ACTIVITY_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
const ACTIVITY_ARTIFACT_MAX_SECONDS = 120;
const FRAME_RATE = 5;
const SAMPLE_RATE = 32_000;
const AUDIO_FRAMES = SAMPLE_RATE / 50;
const AUDIO_BYTES = AUDIO_FRAMES * 4;
const ID = /^artifact:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):([a-f0-9]{48})$/u;
interface ArtifactSourceOptions {
  files: Pick<DeliveredFileStore, "read">;
  temporaryRoot?: string;
  ffmpeg?: string;
  ffprobe?: string;
}

/** Only a hash-checked delivered artifact, never a caller path, URL or new capture permission. */
export function createActivityArtifactSources(
  options: ArtifactSourceOptions,
): NonNullable<ActivitySharingOptions["sources"]> {
  return {
    async resolve(sourceId) {
      const match = ID.exec(sourceId);
      if (match === null) return undefined;
      const found = await options.files.read(match[1]!, match[2]!);
      if (found === undefined || found.data.length > ACTIVITY_ARTIFACT_MAX_BYTES) return undefined;
      const { file, data } = found;
      if (file.mediaType === "image/png") {
        const frame = pngFrame(data, 1);
        return {
          source: { kind: "image", id: sourceId, title: file.filename },
          attach: (_legacy, sink) => {
            sink.publishFrame(frame);
          },
        };
      }
      const demuxer =
        file.mediaType === "image/gif"
          ? "gif"
          : file.mediaType === "video/mp4"
            ? "mov"
            : file.mediaType === "audio/wav" || file.mediaType === "audio/x-wav"
              ? "wav"
              : file.mediaType === "audio/mpeg"
                ? "mp3"
                : undefined;
      if (demuxer === undefined) return undefined;
      const input = await ownedInput(data, options.temporaryRoot);
      let metadata: { duration: number; audio: boolean; video: boolean };
      try {
        metadata = await probe(options.ffprobe ?? "ffprobe", demuxer, input.handle.fd);
      } finally {
        await input.close();
      }
      return {
        source: { kind: demuxer === "gif" ? "animation" : "demo", id: sourceId, title: file.filename },
        attach: async (_legacy, sink) => {
          const decoding = await ownedInput(data, options.temporaryRoot);
          return await decode(options.ffmpeg ?? "ffmpeg", demuxer, decoding, metadata, sink);
        },
      };
    },
  };
}

async function ownedInput(data: Buffer, root = tmpdir()) {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "clankie-activity-artifact-"));
  let handle: FileHandle | undefined;
  try {
    const path = join(directory, "media");
    await writeFile(path, data, { mode: 0o600 });
    handle = await open(path, "r");
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let closed = false;
  return {
    handle,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await handle.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

function inputArguments(demuxer: string) {
  // Match persona-images' inherited regular-file descriptor convention. Forced
  // demuxers exclude playlists; MOV external tracks and absolute aliases are denied.
  return [
    "-protocol_whitelist",
    "file,pipe",
    "-f",
    demuxer,
    ...(demuxer === "mov" ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : []),
    ...(demuxer === "gif" ? ["-ignore_loop", "1"] : []),
    "-i",
    "/dev/fd/3",
  ];
}

async function probe(
  binary: string,
  demuxer: string,
  fd: number,
): Promise<{ duration: number; audio: boolean; video: boolean }> {
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      binary,
      [
        "-v",
        "error",
        ...inputArguments(demuxer),
        "-show_entries",
        "format=duration:stream=codec_type,width,height",
        "-of",
        "json",
      ],
      { stdio: ["ignore", "pipe", "pipe", fd] },
    );
    const output: Buffer[] = [];
    let size = 0,
      failed = false;
    const fail = () => {
      failed = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(fail, 10_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024) fail();
      else output.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024) fail();
    });
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed || code !== 0) reject(new Error("activity_artifact_decode_unavailable"));
      else resolve(Buffer.concat(output));
    });
  });
  const value = JSON.parse(bytes.toString()) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number }[];
  };
  const duration = Number(value.format?.duration);
  const video = value.streams?.find((stream) => stream.codec_type === "video");
  const hasVideo = demuxer === "mov" || demuxer === "gif";
  const audio = value.streams?.some((stream) => stream.codec_type === "audio") ?? false;
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > ACTIVITY_ARTIFACT_MAX_SECONDS ||
    (!hasVideo && !audio) ||
    (hasVideo &&
      (video === undefined ||
        !Number.isSafeInteger(video.width) ||
        !Number.isSafeInteger(video.height) ||
        video.width! < 1 ||
        video.height! < 1 ||
        video.width! > 4096 ||
        video.height! > 4096))
  )
    throw new Error("activity_artifact_media_limit");
  return { duration, audio, video: hasVideo };
}

async function decode(
  binary: string,
  demuxer: string,
  input: Awaited<ReturnType<typeof ownedInput>>,
  metadata: { duration: number; audio: boolean; video: boolean },
  sink: ActivityShareSink,
): Promise<() => void> {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-threads",
    "1",
    "-filter_threads",
    "1",
    "-re",
    ...inputArguments(demuxer),
    ...(metadata.video
      ? [
          "-map",
          "0:v:0",
          "-t",
          String(metadata.duration),
          "-an",
          "-sn",
          "-dn",
          "-vf",
          `fps=${FRAME_RATE},scale=640:640:force_original_aspect_ratio=decrease`,
          "-threads",
          "1",
          "-c:v",
          "png",
          "-f",
          "image2pipe",
          "pipe:1",
        ]
      : []),
    ...(metadata.audio
      ? [
          "-map",
          "0:a:0",
          "-t",
          String(metadata.duration),
          "-vn",
          "-sn",
          "-dn",
          "-ac",
          "2",
          "-ar",
          String(SAMPLE_RATE),
          "-c:a",
          "pcm_s16le",
          "-f",
          "s16le",
          "pipe:4",
        ]
      : []),
  ];
  const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe", input.handle.fd, "pipe"] });
  let ended = false,
    frameSequence = 0,
    audioSequence = 0,
    diagnosticBytes = 0;
  let png: Buffer = Buffer.alloc(0),
    pcm: Buffer = Buffer.alloc(0);
  const stop = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    sink.close();
    void input.close().catch(() => undefined);
    png = Buffer.alloc(0);
    pcm = Buffer.alloc(0);
  };
  const timer = setTimeout(stop, Math.ceil(metadata.duration * 1000) + 10_000);
  timer.unref();
  child.stderr!.on("data", (chunk: Buffer) => {
    diagnosticBytes += chunk.length;
    if (diagnosticBytes > 16 * 1024) stop();
  });
  child.once("close", stop);
  child.once("error", stop);
  child.stdout!.on("data", (chunk: Buffer) => {
    if (ended || !sink.connected) {
      stop();
      return;
    }
    try {
      if (png.length + chunk.length > RENDERED_SURFACE_FRAME_MAX_BYTES + 64 * 1024)
        throw new Error("activity_frame_limit");
      png = Buffer.concat([png, chunk]);
      while (png.length >= 8) {
        let offset = 8,
          complete = false;
        while (offset + 12 <= png.length) {
          const length = png.readUInt32BE(offset);
          if (
            length > RENDERED_SURFACE_FRAME_MAX_BYTES ||
            offset + length + 12 > RENDERED_SURFACE_FRAME_MAX_BYTES
          )
            throw new Error("activity_frame_limit");
          if (offset + length + 12 > png.length) break;
          const kind = png.toString("ascii", offset + 4, offset + 8);
          offset += length + 12;
          if (kind === "IEND") {
            complete = true;
            break;
          }
        }
        if (!complete) break;
        if (++frameSequence > Math.ceil(metadata.duration * FRAME_RATE) + 1)
          throw new Error("activity_frame_limit");
        sink.publishFrame(pngFrame(png.subarray(0, offset), frameSequence));
        png = png.subarray(offset);
      }
    } catch {
      stop();
    }
  });
  (child.stdio[4] as Readable).on("data", (chunk: Buffer) => {
    if (ended || !sink.connected) {
      stop();
      return;
    }
    if (pcm.length + chunk.length > 128 * 1024) {
      stop();
      return;
    }
    pcm = Buffer.concat([pcm, chunk]);
    while (pcm.length >= AUDIO_BYTES) {
      if (++audioSequence > Math.ceil(metadata.duration * 50) + 1) {
        stop();
        return;
      }
      const packet = pcm.subarray(0, AUDIO_BYTES);
      sink.publishAudio({
        schemaVersion: 2,
        sequence: audioSequence,
        encoding: "pcm_s16le",
        sampleRate: SAMPLE_RATE,
        channels: 2,
        frames: AUDIO_FRAMES,
        data: packet.toString("base64"),
        byteLength: packet.length,
        capturedAt: new Date().toISOString(),
      });
      pcm = pcm.subarray(AUDIO_BYTES);
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (!metadata.video)
      sink.publishStatus({ schemaVersion: 2, phase: "acting", updatedAt: new Date().toISOString() });
    return stop;
  } catch {
    stop();
    throw new Error("activity_artifact_decode_unavailable");
  }
}

function pngFrame(data: Buffer, sequence: number) {
  return ActivityShareFrameSchema.parse({
    schemaVersion: 2,
    sequence,
    encoding: "png",
    width: data.length >= 24 ? data.readUInt32BE(16) : 0,
    height: data.length >= 24 ? data.readUInt32BE(20) : 0,
    data: data.toString("base64"),
    byteLength: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
    capturedAt: new Date().toISOString(),
  });
}
