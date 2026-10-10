import { open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  isGeneratedMediaRef,
  VIDEO_IMAGE_DATA_URI_PATTERN,
  type GenerateVideoRequest,
  type GenerateVideoResult,
} from "@clankie/protocol";

/**
 * `generate_video` for fleet workers (VUH-2037).
 *
 * A worker's frames are usually files it is working on, such as a sprite in its
 * checkout, and a model cannot type a PNG as base64. So the bridge, unlike the
 * protocol, takes an absolute path, but only from a worker on this machine
 * proven by local fleet admission. That worker can already read the file, and
 * only PNG, JPEG and WebP bytes are sent. A fleet joined over a bearer link
 * may live on another machine, where a path here would name this Mac's files:
 * it passes artifact references or data URIs only.
 */
export const WORKER_VIDEO_TOOL = "clankie_generate_video";
const FRAME_BYTES_MAX = 8 * 1024 * 1024;

const FrameSchema = z
  .string()
  .min(1)
  .max(12_000_000)
  .describe("An absolute path to a PNG, JPEG or WebP file, an artifactRef, or an image data URI.");

export const WorkerVideoSchema = z.strictObject({
  prompt: z.string().min(1).max(4_000).optional(),
  requestId: z.string().min(1).max(200).optional(),
  firstFrame: FrameSchema.optional(),
  lastFrame: FrameSchema.optional(),
  referenceImages: z.array(FrameSchema).min(1).max(3).optional(),
  aspectRatio: z.string().max(16).optional(),
  durationSeconds: z.number().int().min(1).max(15).optional(),
});

export const workerVideoCatalogEntry = {
  qualifiedName: WORKER_VIDEO_TOOL,
  description:
    "Make a short video with Clankie's owner-chosen video model. Give a prompt, and optionally firstFrame to animate a picture, lastFrame to end on one (the same picture as firstFrame makes a seamless loop) and up to three referenceImages. Frames are absolute PNG/JPEG/WebP paths on this machine, artifactRefs or data URIs. 'pending' is normal: call again with only its requestId. 'ok' carries the video's local path. A video model is a motion reference: snap pixel art back to its palette and grid.",
  inputSchema: z.toJSONSchema(WorkerVideoSchema),
};

export interface WorkerVideoPort {
  generateVideo(
    request: GenerateVideoRequest,
    options?: { signal?: AbortSignal },
  ): Promise<GenerateVideoResult>;
  /** The file behind an artifactRef he made, for a caller on this machine. */
  localPath(artifactRef: string): string;
}

export async function workerVideoRequest(
  input: z.infer<typeof WorkerVideoSchema>,
  local: boolean,
): Promise<GenerateVideoRequest> {
  const frame = (value: string) => workerFrame(value, local);
  return {
    schemaVersion: 1,
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.aspectRatio === undefined ? {} : { aspectRatio: input.aspectRatio }),
    ...(input.durationSeconds === undefined ? {} : { durationSeconds: input.durationSeconds }),
    ...(input.firstFrame === undefined ? {} : { firstFrame: await frame(input.firstFrame) }),
    ...(input.lastFrame === undefined ? {} : { lastFrame: await frame(input.lastFrame) }),
    ...(input.referenceImages === undefined
      ? {}
      : { referenceImages: await Promise.all(input.referenceImages.map(frame)) }),
  };
}

async function workerFrame(value: string, local: boolean): Promise<string> {
  if (isGeneratedMediaRef(value) || VIDEO_IMAGE_DATA_URI_PATTERN.test(value)) return value;
  if (!isAbsolute(value)) throw new Error("A frame is an absolute image path, an artifactRef or a data URI");
  if (!local) throw new Error("Frame paths need a worker on this machine; send a data URI instead");
  const handle = await open(await realpath(value), "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > FRAME_BYTES_MAX)
      throw new Error("A frame must be an image file up to 8 MiB");
    const bytes = await handle.readFile();
    const mimeType = imageMimeType(bytes);
    if (mimeType === undefined) throw new Error("A frame must be a PNG, JPEG or WebP image");
    return `data:${mimeType};base64,${bytes.toString("base64")}`;
  } finally {
    await handle.close();
  }
}

/** By magic bytes, so a path to anything else is refused whatever its name says. */
function imageMimeType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return undefined;
}
