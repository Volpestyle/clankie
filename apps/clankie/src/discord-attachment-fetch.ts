import {
  DISCORD_PRESENCE_ATTACHMENT_BYTES_MAX,
  DISCORD_PRESENCE_ATTACHMENT_MEDIA_TYPES,
  type DiscordPresenceAttachment,
} from "@clankie/protocol";

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

export interface ResolvedDiscordAttachment {
  readonly id: string;
  readonly mediaType: DiscordPresenceAttachment["mediaType"];
  readonly filename?: string;
  /** `data:<mediaType>;base64,…` — the form the model receives as an AI SDK file part. */
  readonly dataUrl: string;
}

export interface DiscordAttachmentFetchOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export type DiscordAttachmentResolver = (
  attachments: readonly DiscordPresenceAttachment[],
) => Promise<readonly ResolvedDiscordAttachment[]>;

/**
 * Resolves a turn's attachments concurrently, dropping any that fail.
 *
 * The count of what was dropped is the caller's to report; this returns only
 * what it actually holds bytes for, so a partial result can never be mistaken
 * for a complete one.
 */
export function createDiscordAttachmentResolver(
  options: DiscordAttachmentFetchOptions = {},
): DiscordAttachmentResolver {
  return async (attachments) => {
    const settled = await Promise.all(
      attachments.map(async (attachment) => {
        try {
          return await fetchDiscordAttachment(attachment, options);
        } catch {
          return undefined;
        }
      }),
    );
    return settled.filter((entry): entry is ResolvedDiscordAttachment => entry !== undefined);
  };
}

export async function fetchDiscordAttachment(
  attachment: DiscordPresenceAttachment,
  options: DiscordAttachmentFetchOptions = {},
): Promise<ResolvedDiscordAttachment> {
  const url = new URL(attachment.url);
  if (url.protocol !== "https:") throw new Error("discord_attachment_scheme_unsupported");
  if (!ALLOWED_HOSTS.has(url.hostname) && !DISCORD_IMAGE_PROXY_HOST.test(url.hostname)) {
    throw new Error("discord_attachment_host_not_allowlisted");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error("discord_attachment_fetch_failed");

    // The declared type is re-checked against the same allowlist ingress used:
    // what the CDN actually serves is the thing being handed to the model, and
    // it does not have to match what the gateway payload claimed.
    const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (mediaType === undefined || !isSupportedMediaType(mediaType)) {
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
    return {
      id: attachment.id,
      mediaType,
      ...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
      dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function isSupportedMediaType(value: string): value is DiscordPresenceAttachment["mediaType"] {
  return (DISCORD_PRESENCE_ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(value);
}
