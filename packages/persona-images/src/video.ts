import { spawn } from "node:child_process";
import { z } from "zod";
import { PERSONA_IMAGE_LIMITS, PixelSchema, processImage } from "./processing.ts";

export const VideoSchema = z.object({
  duration: z.number().positive().max(PERSONA_IMAGE_LIMITS.videoSeconds),
  frames: z
    .array(PixelSchema.extend({ timestamp: z.number().nonnegative(), fingerprint: z.string().length(1024) }))
    .min(1)
    .max(PERSONA_IMAGE_LIMITS.framesPerVideo),
});
/** Bounded subprocess, no shell, and an inherited regular-file descriptor rather than re-opening a path. */
async function run(
  binary: string,
  args: string[],
  fd?: number,
): Promise<{ output: Buffer; fingerprint: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe", fd ?? "ignore", "pipe"] });
    const output: Buffer[] = [],
      fingerprint: Buffer[] = [];
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
    const extra = child.stdio[4];
    if (extra && "on" in extra) extra.on("data", collect(fingerprint));
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
      else resolve({ output: Buffer.concat(output), fingerprint: Buffer.concat(fingerprint) });
    });
  });
}
export async function checkVideoTools(tools: { ffmpeg: string; ffprobe: string }): Promise<void> {
  await run(tools.ffmpeg, ["-version"]);
  await run(tools.ffprobe, ["-version"]);
}
/** Mean RGB difference on a 16x16 thumbnail; ignores tiny codec/screen-recording noise. */
function nearDuplicate(left: string, right: string): boolean {
  const a = Buffer.from(left, "base64"),
    b = Buffer.from(right, "base64");
  if (a.length !== 768 || b.length !== 768) return false;
  let delta = 0;
  for (let i = 0; i < a.length; i++) delta += Math.abs(a[i]! - b[i]!);
  return delta / a.length <= 2;
}
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
  const duration = Number(probe.output.toString().trim());
  if (!Number.isFinite(duration) || duration <= 0 || duration > PERSONA_IMAGE_LIMITS.videoSeconds)
    throw new Error("video_duration_limit");
  const frames: z.infer<typeof VideoSchema>["frames"] = [];
  for (let i = 0; i < PERSONA_IMAGE_LIMITS.framesPerVideo; i++) {
    const timestamp = Number(((duration * (i + 0.5)) / PERSONA_IMAGE_LIMITS.framesPerVideo).toFixed(3));
    const { output, fingerprint } = await run(
      tools.ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-threads",
        "1",
        "-ss",
        String(timestamp),
        ...input,
        "-filter_complex_threads",
        "1",
        "-filter_complex",
        "[0:v:0]split=2[frame][thumb];[frame]scale=w='min(1024,iw)':h='min(1024,ih)':force_original_aspect_ratio=decrease[picture];[thumb]scale=16:16,format=rgb24[small]",
        "-map",
        "[picture]",
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
        "-map",
        "[small]",
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-dn",
        "-threads",
        "1",
        "-c:v",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:4",
      ],
      fd,
    );
    if (fingerprint.length !== 768) throw new Error("video_frame_unavailable");
    const signature = fingerprint.toString("base64");
    if (frames.some((frame) => nearDuplicate(frame.fingerprint, signature))) continue;
    frames.push({ ...(await processImage(output)), timestamp, fingerprint: signature });
  }
  return VideoSchema.parse({ duration, frames });
}
