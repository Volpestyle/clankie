import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkMediaEntry } from "@clankie/protocol";
import type { EvidenceStore } from "./evidence-store.ts";
import { LinearUploadRefused, storeEvidenceBytes } from "./linear-import.ts";

/** Links a returned item must have carried before the service fetches them. */
const LINEAR_UPLOAD = /https:\/\/(?:uploads|public)\.linear\.app\/[^\s<>()[\]"'\\`]+/gu;
const EVIDENCE_LINK = /^clankie:\/\/evidence\/sha256\/([0-9a-f]{64})$/u;
const SEEN_LIMIT = 4096;
const SEEN_TTL_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 5 * 60 * 1000;
const DOWNLOADS = 2;

type Cached = { sha256: string; size: number; contentType: string };

export interface WorkMediaOptions {
  readonly evidence: Pick<EvidenceStore, "upload" | "acceptBlob" | "lookup" | "recordForBlob">;
  /** A credentialed, bounded read of one Linear upload (`downloadLinearUpload`). */
  readonly download: (url: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
  readonly directory: string;
  readonly clock?: () => number;
  readonly log?: (fields: Record<string, unknown>, message: string) => void;
}

/**
 * Media embedded in tracker items, resolved for the owner's devices (VUH-2666).
 * Only a Linear upload some returned item carried is ever fetched, once, with the
 * connected app; the bytes become an evidence blob the device reads through its
 * existing preview and fetch ops. It is not a proxy for arbitrary URLs.
 */
export class WorkMedia {
  readonly #seen = new Map<string, { url: string; at: number }>();
  readonly #failed = new Map<string, { reason: "not_found" | "too_large" | "unavailable"; at: number }>();
  readonly #running = new Map<string, Promise<void>>();
  readonly #queue: (() => void)[] = [];
  #active = 0;
  #cache: Promise<Record<string, Cached>> | undefined;
  /** Cache writes, one after another, so the newest file is the one left on disk (VUH-2922). */
  #writing: Promise<void> = Promise.resolve();
  readonly #clock: () => number;
  private readonly options: WorkMediaOptions;

  constructor(options: WorkMediaOptions) {
    this.options = options;
    this.#clock = options.clock ?? Date.now;
  }

  /** Remembers each Linear upload link in a tracker result the service is returning. */
  observe(value: unknown): void {
    const now = this.#clock();
    const visit = (child: unknown) => {
      if (typeof child === "string") {
        for (const match of child.matchAll(LINEAR_UPLOAD)) {
          const key = stableKey(match[0]);
          if (key === undefined) continue;
          this.#seen.delete(key);
          this.#seen.set(key, { url: match[0], at: now });
        }
      } else if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") Object.values(child).forEach(visit);
    };
    visit(value);
    for (const key of this.#seen.keys()) {
      if (this.#seen.size <= SEEN_LIMIT) break;
      this.#seen.delete(key);
    }
  }

  async resolve(urls: readonly string[]): Promise<WorkMediaEntry[]> {
    const cache = await this.#readCache();
    return Promise.all(urls.map((url) => this.#resolveOne(url, cache)));
  }

  async #resolveOne(url: string, cache: Record<string, Cached>): Promise<WorkMediaEntry> {
    const evidence = EVIDENCE_LINK.exec(url)?.[1];
    if (evidence !== undefined) {
      const record = await this.options.evidence.recordForBlob(evidence);
      return record ? ready(url, record) : { url, state: "failed", reason: "not_found" };
    }
    const key = stableKey(url);
    if (key === undefined) return { url, state: "failed", reason: "not_returned" };
    const cached = cache[key];
    if (cached && (await this.options.evidence.recordForBlob(cached.sha256))) return ready(url, cached);
    const seen = this.#seen.get(key);
    if (!seen || this.#clock() - seen.at > SEEN_TTL_MS)
      return { url, state: "failed", reason: "not_returned" };
    const failed = this.#failed.get(key);
    if (failed && this.#clock() - failed.at < RETRY_AFTER_MS)
      return { url, state: "failed", reason: failed.reason };
    if (!this.#running.has(key)) {
      const run = this.#download(key, seen.url).finally(() => this.#running.delete(key));
      this.#running.set(key, run);
    }
    return { url, state: "pending" };
  }

  async #download(key: string, url: string) {
    await new Promise<void>((resolve) => {
      if (this.#active < DOWNLOADS) {
        this.#active++;
        resolve();
      } else
        this.#queue.push(() => {
          this.#active++;
          resolve();
        });
    });
    try {
      const { bytes, contentType } = await this.options.download(url);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const type = mediaType(contentType, bytes, key);
      const actor = {
        kind: "operator" as const,
        id: "work-media",
        name: "Clankie tracker media",
        onBehalfOf: [{ kind: "human", id: "owner" }],
      };
      await storeEvidenceBytes(this.options.evidence, actor, bytes, {
        idempotencyKey: createHash("sha256").update(`work-media:${key}:${sha256}`).digest("hex"),
        sha256,
        size: bytes.byteLength,
        contentType: type,
        fileName: fileName(key, sha256),
        caption: "Media from a Linear item",
      });
      await this.#record(key, { sha256, size: bytes.byteLength, contentType: type });
      this.#failed.delete(key);
    } catch (error) {
      const reason = error instanceof LinearUploadRefused ? error.reason : "unavailable";
      this.#failed.set(key, { reason, at: this.#clock() });
      this.options.log?.(
        {
          event: "work.media.unavailable",
          reason,
          error: error instanceof Error ? error.message : String(error),
        },
        "Tracker media could not be fetched",
      );
    } finally {
      this.#active--;
      this.#queue.shift()?.();
    }
  }

  /** Only a cache: a missing or damaged file starts empty, and a failed read is tried again next time. */
  #readCache(): Promise<Record<string, Cached>> {
    this.#cache ??= readFile(join(this.options.directory, "work-media.json"), "utf8").then(
      (text) => {
        try {
          const parsed: unknown = JSON.parse(text);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            return parsed as Record<string, Cached>;
        } catch {
          // A damaged file is rewritten by the next download.
        }
        return {} as Record<string, Cached>;
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return {} as Record<string, Cached>;
        this.#cache = undefined;
        throw error;
      },
    );
    return this.#cache;
  }

  /**
   * Writes one finished download into the cache file, after any write already under way, and
   * only then serves it as ready. Each write takes its snapshot in turn, so it holds every entry
   * before it and a slower, older snapshot can never rename over a newer one (VUH-2922).
   */
  #record(key: string, entry: Cached): Promise<void> {
    const write = this.#writing.then(async () => {
      const cache = await this.#readCache();
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      const path = join(this.options.directory, "work-media.json");
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ ...cache, [key]: entry }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
      cache[key] = entry;
    });
    // allow-swallowed-rejection -- the download awaiting `write` gets this failure; the chain only keeps going.
    this.#writing = write.catch(() => undefined);
    return write;
  }
}

/** A signed link changes every read; its upload is the same path without the query. */
function stableKey(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !["uploads.linear.app", "public.linear.app"].includes(url.hostname)
    )
      return undefined;
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function ready(url: string, record: Cached): WorkMediaEntry {
  const kind = record.contentType.startsWith("image/")
    ? "image"
    : record.contentType.startsWith("video/")
      ? "video"
      : "file";
  if (!/^[0-9a-f]{64}$/u.test(record.sha256)) return { url, state: "failed", reason: "unavailable" };
  return {
    url,
    state: "ready",
    sha256: record.sha256,
    contentType: record.contentType,
    kind,
    size: record.size,
  };
}

/**
 * Only types a device shows as media keep their name: raster images, video and
 * PDF. Anyone in the workspace can upload, so HTML, SVG and the rest are
 * recorded as octet-stream and never become inline-renderable evidence. Linear
 * sometimes serves uploads as octet-stream; then the bytes say what they are.
 */
function mediaType(declared: string, bytes: Uint8Array, key: string): string {
  const type = declared.toLowerCase();
  if (/^(?:image|video)\/[\w.+-]+$/u.test(type) ? type !== "image/svg+xml" : type === "application/pdf")
    return type;
  const head = Buffer.from(bytes.subarray(0, 16));
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP")
    return "image/webp";
  if (head.subarray(4, 8).toString("latin1") === "ftyp")
    return head.subarray(8, 12).toString("latin1") === "qt  " || /\.mov$/iu.test(key)
      ? "video/quicktime"
      : "video/mp4";
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "video/webm";
  return "application/octet-stream";
}

function fileName(key: string, sha256: string) {
  try {
    return decodeURIComponent(new URL(key).pathname.split("/").at(-1) || sha256)
      .replace(/[\r\n]/gu, " ")
      .slice(0, 200);
  } catch {
    return sha256;
  }
}
