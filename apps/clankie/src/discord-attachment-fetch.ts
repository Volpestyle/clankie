import {
  DISCORD_PRESENCE_ATTACHMENT_BYTES_MAX,
  DISCORD_PRESENCE_ATTACHMENT_MEDIA_TYPES,
  DISCORD_PRESENCE_MOTION_FRAMES_MAX,
  type DiscordPresenceAttachment,
} from "@clankie/protocol";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Resolving a Discord attachment reference into bytes the model can see.
 *
 * This is the only place in the system that turns an untrusted URL into
 * content, so every bound lives here rather than being spread across callers:
 *
 * - **Host allowlist.** Discord's CDN and image proxy only. The URL arrives on an untrusted
 *   gateway payload, and an unbounded fetch driven by attacker-chosen URLs is
 *   an SSRF primitive regardless of what the schema says about it.
 * - **Size ceiling twice.** Once on the declared `Content-Length` and again on
 *   the bytes actually read, because a lying or absent header must not become a
 *   memory ceiling.
 * - **No redirects.** A redirect is how an allowlisted host becomes a
 *   non-allowlisted one.
 * - **Bounded time.** A hung CDN must not hold a Discord turn open; the message
 *   is already in a channel where someone is waiting.
 *
 * A failure here is never a failed turn. He is told an image could not be read
 * and answers anyway — the harness tells him the truth rather than narrating a
 * picture nobody fetched (ADR 0072).
 */

const ALLOWED_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const DISCORD_IMAGE_PROXY_HOST = /^images-ext-\d+\.discordapp\.net$/u;
const DEFAULT_TIMEOUT_MS = 10_000;
const MOTION_PROCESS_TIMEOUT_MS = 5_000;
const MOTION_DURATION_MAX_SECONDS = 60;
const MOTION_MEDIA_TYPES = new Set(["video/mp4", "video/webm"]);
const execFileAsync = promisify(execFile);

export interface ResolvedDiscordAttachment {
  readonly id: string;
  readonly mediaType: DiscordPresenceAttachment["mediaType"];
  readonly filename?: string;
  readonly frameIndex?: number;
  readonly frameCount?: number;
  /** `data:<mediaType>;base64,…` — the form the model receives as an AI SDK file part. */
  readonly dataUrl: string;
}

export interface DiscordAttachmentFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly extractMotionFrames?: MotionFrameExtractor;
}

type MotionFrameExtractor = (bytes: Buffer, count: number) => Promise<readonly Buffer[]>;

export type DiscordAttachmentResolver = (
  attachments: readonly DiscordPresenceAttachment[],
) => Promise<readonly ResolvedDiscordAttachment[]>;

/**
 * Resolves a turn's visuals, expanding motion into chronological frames and
 * dropping any source that fails. The final model-image count never exceeds
 * the same four-image bound ingress applies to a message.
 *
 * The count of what was dropped is the caller's to report; this returns only
 * what it actually holds bytes for, so a partial result can never be mistaken
 * for a complete one.
 */
export function createDiscordAttachmentResolver(
  options: DiscordAttachmentFetchOptions = {},
): DiscordAttachmentResolver {
  return async (attachments) => {
    const resolved: ResolvedDiscordAttachment[] = [];
    for (const attachment of attachments) {
      if (resolved.length >= DISCORD_PRESENCE_MOTION_FRAMES_MAX) break;
      if (attachment.motionUrl !== undefined) {
        try {
          const frames = await fetchDiscordMotionFrames(
            attachment,
            DISCORD_PRESENCE_MOTION_FRAMES_MAX - resolved.length,
            options,
          );
          if (frames.length > 0) {
            resolved.push(...frames);
            continue;
          }
        } catch {
          // The static preview below is the honest fallback for failed motion.
        }
      }
      try {
        resolved.push(await fetchDiscordAttachment(attachment, options));
      } catch {
        // A failed visual costs the picture, not the conversation.
      }
    }
    return resolved;
  };
}

export async function fetchDiscordAttachment(
  attachment: DiscordPresenceAttachment,
  options: DiscordAttachmentFetchOptions = {},
): Promise<ResolvedDiscordAttachment> {
  const { bytes, mediaType } = await fetchDiscordBytes(
    attachment.url,
    (value): value is DiscordPresenceAttachment["mediaType"] => isSupportedMediaType(value),
    options,
  );
  return {
    id: attachment.id,
    mediaType,
    ...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
    dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`,
  };
}

async function fetchDiscordMotionFrames(
  attachment: DiscordPresenceAttachment,
  count: number,
  options: DiscordAttachmentFetchOptions,
): Promise<readonly ResolvedDiscordAttachment[]> {
  if (attachment.motionUrl === undefined || count <= 0) return [];
  const { bytes } = await fetchDiscordBytes(
    attachment.motionUrl,
    (value): value is string => MOTION_MEDIA_TYPES.has(value),
    options,
  );
  const extracted = await (options.extractMotionFrames ?? extractMotionFrames)(bytes, count);
  const frames = extracted
    .filter((frame) => frame.byteLength > 0 && frame.byteLength <= DISCORD_PRESENCE_ATTACHMENT_BYTES_MAX)
    .slice(0, count);
  return frames.map((frame, index) => ({
    id: attachment.id,
    mediaType: "image/png",
    frameIndex: index + 1,
    frameCount: frames.length,
    dataUrl: `data:image/png;base64,${frame.toString("base64")}`,
  }));
}

async function fetchDiscordBytes<T extends string>(
  rawUrl: string,
  supportsMediaType: (value: string) => value is T,
  options: DiscordAttachmentFetchOptions,
): Promise<{ readonly bytes: Buffer; readonly mediaType: T }> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("discord_attachment_scheme_unsupported");
  if (!ALLOWED_HOSTS.has(url.hostname) && !DISCORD_IMAGE_PROXY_HOST.test(url.hostname)) {
    throw new Error("discord_attachment_host_not_allowlisted");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("discord_attachment_fetch_failed");

  // The declared type is re-checked against the same allowlist ingress used:
  // what the CDN actually serves is the thing being handed to the model, and
  // it does not have to match what the gateway payload claimed.
  const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType === undefined || !supportsMediaType(mediaType)) {
    throw new Error("discord_attachment_media_type_unsupported");
  }
  const declaredLength = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declaredLength) && declaredLength > DISCORD_PRESENCE_ATTACHMENT_BYTES_MAX) {
    throw new Error("discord_attachment_too_large");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("discord_attachment_empty");
  if (bytes.byteLength > DISCORD_PRESENCE_ATTACHMENT_BYTES_MAX) {
    throw new Error("discord_attachment_too_large");
  }
  return { bytes, mediaType };
}

async function extractMotionFrames(bytes: Buffer, count: number): Promise<readonly Buffer[]> {
  if (!Number.isInteger(count) || count <= 0 || count > DISCORD_PRESENCE_MOTION_FRAMES_MAX) {
    throw new Error("discord_motion_frame_count_invalid");
  }
  const directory = await mkdtemp(join(tmpdir(), "clankie-discord-motion-"));
  const input = join(directory, "input.video");
  try {
    await writeFile(input, bytes);
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", input],
      { timeout: MOTION_PROCESS_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    const duration = Number(stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0 || duration > MOTION_DURATION_MAX_SECONDS) {
      throw new Error("discord_motion_duration_unsupported");
    }

    const outputs = await Promise.all(
      Array.from({ length: count }, async (_unused, index) => {
        const output = join(directory, `frame-${String(index)}.png`);
        const timestamp = (duration * (index + 0.5)) / count;
        try {
          await execFileAsync(
            "ffmpeg",
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-i",
              input,
              "-ss",
              timestamp.toFixed(3),
              "-frames:v",
              "1",
              "-an",
              "-sn",
              "-dn",
              "-threads",
              "1",
              "-vf",
              "scale=1024:1024:force_original_aspect_ratio=decrease",
              output,
            ],
            { timeout: MOTION_PROCESS_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
          );
          return await readFile(output);
        } catch {
          return undefined;
        }
      }),
    );
    const seen = new Set<string>();
    const frames: Buffer[] = [];
    for (const frame of outputs) {
      if (frame === undefined) continue;
      const digest = createHash("sha256").update(frame).digest("hex");
      if (seen.has(digest)) continue;
      seen.add(digest);
      frames.push(frame);
    }
    return frames;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function isSupportedMediaType(value: string): value is DiscordPresenceAttachment["mediaType"] {
  return (DISCORD_PRESENCE_ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(value);
}
