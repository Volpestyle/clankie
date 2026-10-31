import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import {
  CONNECTOR_IMAGES_PER_MESSAGE_MAX,
  connectorImageMediaType,
} from "../../../packages/protocol/src/connector.ts";
import { OPERATOR_ATTACHMENT_IMAGE_BYTES_MAX } from "../../../packages/protocol/src/operator-conversations.ts";
import type { SessionImage } from "@clankie/agent-hosts/sessions";

// Images a connected app sends an agent (ADR 0315): inline base64, or an https
// address this Mac fetches. Either way the bytes must be a PNG, JPEG, GIF or
// WebP by their own leading bytes, and they then travel as an owner
// attachment into the agent's workspace (ADR 0209).

const FETCH_DEADLINE_MS = 15_000;
const REDIRECTS_MAX = 3;
const EXTENSIONS: Record<SessionImage["mediaType"], string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** A sentence the app can act on; nothing was sent. */
export class ConnectorImageRefusal extends Error {}

type ConnectorImageFetch = (url: URL, init: RequestInit) => Promise<Response>;
type ConnectorHostLookup = (hostname: string) => Promise<readonly string[]>;

export interface ConnectorImageOptions {
  readonly fetch?: ConnectorImageFetch;
  /** Every address a host name resolves to; all of them must be public. */
  readonly lookup?: ConnectorHostLookup;
}

/** The tool's `images` argument as session images, or a refusal saying what is wrong. */
export async function connectorImages(
  value: unknown,
  options: ConnectorImageOptions = {},
): Promise<readonly SessionImage[] | undefined> {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > CONNECTOR_IMAGES_PER_MESSAGE_MAX)
    throw new ConnectorImageRefusal(
      `images is 1 to ${CONNECTOR_IMAGES_PER_MESSAGE_MAX} items, each {url} or {data}. Nothing was sent.`,
    );
  const images: SessionImage[] = [];
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry))
      throw new ConnectorImageRefusal(`images[${index}] is {url} or {data}. Nothing was sent.`);
    const { url, data, name } = entry as Record<string, unknown>;
    if ((url === undefined) === (data === undefined))
      throw new ConnectorImageRefusal(`images[${index}] needs exactly one of url or data. Nothing was sent.`);
    const bytes =
      typeof data === "string"
        ? decodeInline(data, index)
        : typeof url === "string"
          ? await fetchImage(url, index, options)
          : undefined;
    if (bytes === undefined)
      throw new ConnectorImageRefusal(`images[${index}].url and .data are strings. Nothing was sent.`);
    const mediaType = connectorImageMediaType(bytes);
    if (mediaType === undefined)
      throw new ConnectorImageRefusal(
        `images[${index}] isn't a PNG, JPEG, GIF or WebP image. Nothing was sent.`,
      );
    images.push({
      filename: filename(
        typeof name === "string" ? name : typeof url === "string" ? url : "",
        index,
        mediaType,
      ),
      mediaType,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return images;
}

function decodeInline(data: string, index: number): Uint8Array {
  const trimmed = data.replace(/^data:image\/[a-z.+-]+;base64,/iu, "").replace(/\s+/gu, "");
  if (trimmed.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(trimmed))
    throw new ConnectorImageRefusal(`images[${index}].data isn't base64. Nothing was sent.`);
  const bytes = Buffer.from(trimmed, "base64");
  if (bytes.byteLength > OPERATOR_ATTACHMENT_IMAGE_BYTES_MAX)
    throw new ConnectorImageRefusal(tooLarge(index));
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function fetchImage(raw: string, index: number, options: ConnectorImageOptions): Promise<Uint8Array> {
  const fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  const resolveHost = options.lookup ?? systemLookup;
  const signal = AbortSignal.timeout(FETCH_DEADLINE_MS);
  let url = publicHttpsUrl(raw, index);
  for (let hop = 0; ; hop += 1) {
    await assertPublicHost(url, index, resolveHost);
    let response: Response;
    try {
      response = await fetcher(url, {
        redirect: "manual",
        signal,
        headers: { accept: "image/png, image/jpeg, image/gif, image/webp" },
      });
    } catch {
      throw new ConnectorImageRefusal(
        `images[${index}] couldn't be fetched from ${url.host}. Nothing was sent.`,
      );
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (location === null || hop >= REDIRECTS_MAX)
        throw new ConnectorImageRefusal(`images[${index}] redirected too many times. Nothing was sent.`);
      url = publicHttpsUrl(new URL(location, url).href, index);
      continue;
    }
    if (!response.ok || response.body === null) {
      await response.body?.cancel().catch(() => undefined);
      throw new ConnectorImageRefusal(
        `images[${index}] answered ${response.status} from ${url.host}. Nothing was sent.`,
      );
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > OPERATOR_ATTACHMENT_IMAGE_BYTES_MAX) {
      await response.body.cancel().catch(() => undefined);
      throw new ConnectorImageRefusal(tooLarge(index));
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > OPERATOR_ATTACHMENT_IMAGE_BYTES_MAX) {
          await reader.cancel().catch(() => undefined);
          throw new ConnectorImageRefusal(tooLarge(index));
        }
        chunks.push(chunk.value);
      }
    } catch (error) {
      if (error instanceof ConnectorImageRefusal) throw error;
      throw new ConnectorImageRefusal(
        `images[${index}] stopped downloading from ${url.host}. Nothing was sent.`,
      );
    }
    return Buffer.concat(chunks);
  }
}

function publicHttpsUrl(raw: string, index: number): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConnectorImageRefusal(`images[${index}].url isn't an address. Nothing was sent.`);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "")
    throw new ConnectorImageRefusal(
      `images[${index}].url must be an https address without a user name or password. Nothing was sent.`,
    );
  return url;
}

/** Only public addresses: never this Mac, its network, or a tailnet. */
async function assertPublicHost(url: URL, index: number, resolveHost: ConnectorHostLookup): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const refused = () =>
    new ConnectorImageRefusal(
      `images[${index}].url points at a private or local address, which Clankie doesn't fetch. Nothing was sent.`,
    );
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".ts.net") ||
    !hostname.includes(".") ||
    (url.port !== "" && url.port !== "443")
  )
    throw refused();
  const addresses = isIP(hostname) === 0 ? await resolveHost(hostname).catch(() => []) : [hostname];
  if (addresses.length === 0)
    throw new ConnectorImageRefusal(
      `images[${index}].url's host ${hostname} doesn't resolve. Nothing was sent.`,
    );
  if (addresses.some((address) => !isPublicAddress(address))) throw refused();
}

const PRIVATE = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const)
  PRIVATE.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96],
] as const)
  PRIVATE.addSubnet(network, prefix, "ipv6");

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(address)?.[1];
    if (mapped !== undefined) return isPublicAddress(mapped);
    return !PRIVATE.check(address, "ipv6");
  }
  return !PRIVATE.check(address, "ipv4");
}

async function systemLookup(hostname: string): Promise<readonly string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

/** A safe name with the extension of what the bytes are. */
function filename(source: string, index: number, mediaType: SessionImage["mediaType"]): string {
  const last = source.split(/[?#]/u)[0]!.split("/").at(-1) ?? "";
  const stem = last
    .replace(/\.[A-Za-z0-9]{1,5}$/u, "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "")
    .slice(0, 80);
  return `${stem.length === 0 ? `image-${index + 1}` : stem}${EXTENSIONS[mediaType]}`;
}

function tooLarge(index: number): string {
  return `images[${index}] is over ${OPERATOR_ATTACHMENT_IMAGE_BYTES_MAX / (1024 * 1024)} MiB. Nothing was sent.`;
}
