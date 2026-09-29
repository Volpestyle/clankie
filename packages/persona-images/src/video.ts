import { spawn } from "node:child_process";
import { z } from "zod";
import { PERSONA_IMAGE_LIMITS, SheetPixelSchema, processImage } from "./processing.ts";

export const VideoSchema = z.object({
  duration: z.number().positive().max(PERSONA_IMAGE_LIMITS.videoSeconds),
  sheet: SheetPixelSchema,
  timestamps: z.array(z.number().nonnegative()).length(PERSONA_IMAGE_LIMITS.framesPerVideo),
});
/** Bounded subprocess, no shell, and an inherited regular-file descriptor rather than re-opening a path. */
async function run(binary: string, args: string[], fd?: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe", fd ?? "ignore"] });
    const output: Buffer[] = [];
    let size = 0,
      failure: Error | undefined;
    const fail = (reason: string) => {
      failure = new Error(reason);
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => fail("video_processing_timeout"), 20_000);
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) fail("video_output_limit");
      else chunks.push(chunk);
    };
    child.stdout!.on("data", collect(output));
    child.stderr!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) fail("video_output_limit");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure = new Error(
        error.code === "ENOENT"
          ? `${binary.endsWith("ffprobe") ? "ffprobe" : "ffmpeg"}_missing`
          : "video_tool_unavailable",
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error("video_decode_failed"));
      else resolve(Buffer.concat(output));
    });
  });
}
export async function checkVideoTools(tools: { ffmpeg: string; ffprobe: string }): Promise<void> {
  await run(tools.ffmpeg, ["-version"]);
  await run(tools.ffprobe, ["-version"]);
}
/** One chronological contact sheet per clip, retaining repetition as temporal context. */
export async function sampleVideo(fd: number, extension: string, tools: { ffmpeg: string; ffprobe: string }) {
  // Forced demuxers exclude playlists; network protocols and audio are never consumed.
  const input = [
    "-protocol_whitelist",
    "file,pipe",
    "-f",
    extension === ".webm" ? "matroska,webm" : "mov",
    "-i",
    "/dev/fd/3",
  ];
  const probe = await run(
    tools.ffprobe,
    ["-v", "error", ...input, "-show_entries", "format=duration", "-of", "default=nk=1:nw=1"],
    fd,
  );
  const duration = Number(probe.toString().trim());
  if (!Number.isFinite(duration) || duration <= 0 || duration > PERSONA_IMAGE_LIMITS.videoSeconds)
    throw new Error("video_duration_limit");
  const count = PERSONA_IMAGE_LIMITS.framesPerVideo;
  const timestamps = Array.from({ length: count }, (_, i) =>
    Number(((duration * (i + 0.5)) / count).toFixed(3)),
  );
  const edge = PERSONA_IMAGE_LIMITS.sheetTileEdge;
  // Normalize PTS, sample the centers of ten equal temporal bins, then pad the
  // final held frame if a short/low-frame-rate clip ends before the final bin.
  // Audio is not decoded. One bounded decode avoids ten independent seeks.
  const output = await run(
    tools.ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-threads",
      "1",
      ...input,
      "-filter_threads",
      "1",
      "-vf",
      `setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${duration / count},fps=fps=${count / duration}:start_time=${duration / (2 * count)}:round=near:eof_action=pass,scale=${edge}:${edge}:force_original_aspect_ratio=decrease,setsar=1,tile=${PERSONA_IMAGE_LIMITS.sheetColumns}x${PERSONA_IMAGE_LIMITS.sheetRows}:nb_frames=${count}`,
      "-frames:v",
      "1",
      "-an",
      "-sn",
      "-dn",
      "-threads",
      "1",
      "-c:v",
      "png",
      "-f",
      "image2pipe",
      "pipe:1",
    ],
    fd,
  );
  return VideoSchema.parse({ duration, timestamps, sheet: await processImage(output, true) });
}
