import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DISCORD_STREAM_WATCH_FRAME_HISTORY_MAX,
  DiscordStreamWatchObservationSchema,
  DiscordStreamWatchReportSchema,
  SHARE_ARTIFACT_DIRECTORY,
  isShareArtifactRef,
  type DiscordStreamWatchObservation,
  type DiscordStreamWatchReport,
} from "@clankie/protocol";

/**
 * How long a written still stays readable after it was last produced. A still
 * `observe_share` attaches rides that turn's reply, which the bridge resolves
 * within the turn's lifetime (minutes), so this comfortably outlives it.
 */
const SHARE_ARTIFACT_RETENTION_MS = 15 * 60 * 1_000;
/** Disk the stills may hold at once; changing video writes about one a second. */
const SHARE_ARTIFACT_BYTES_MAX = 64 * 1024 * 1024;

export interface ShareArtifactRetention {
  readonly maxAgeMs: number;
  readonly maxBytes: number;
}

/**
 * Latest view plus a short rolling history of Discord screen shares.
 *
 * Memory-first: raw video never enters the event log. A still is optional and
 * is written under `shares/` only when an attachment root is configured, so
 * `observe_share` can harvest it the same way a browser screenshot is harvested.
 *
 * `shares/` has no other writer, so this projection also retires it: a still
 * leaves once it is older than the retention window or the directory is over
 * its byte budget, oldest first, but never while the current view still shows
 * it. Stills from an earlier process are adopted into the same budget on start.
 */
export class DiscordStreamWatchProjection {
  private readonly artifactRoot: string | undefined;
  private readonly retention: ShareArtifactRetention;
  /** Written stills by digest, oldest write first. */
  private readonly written = new Map<string, { readonly bytes: number; readonly writtenAtMs: number }>();
  private writtenBytes = 0;
  private directoryReady = false;
  private readonly bySource = new Map<"bot" | "user_session", DiscordStreamWatchReport["streams"]>();
  private currentObservation: DiscordStreamWatchObservation = {
    schemaVersion: 1,
    streams: [],
    decoder: "idle",
  };

  public constructor(
    artifactRoot?: string,
    retention: ShareArtifactRetention = {
      maxAgeMs: SHARE_ARTIFACT_RETENTION_MS,
      maxBytes: SHARE_ARTIFACT_BYTES_MAX,
    },
  ) {
    this.artifactRoot = artifactRoot;
    this.retention = retention;
    this.adoptExistingStills();
  }

  public apply(report: DiscordStreamWatchReport, now: Date = new Date()): DiscordStreamWatchObservation {
    const parsed = DiscordStreamWatchReportSchema.parse(report);
    this.bySource.set(parsed.source, parsed.streams);

    let frame = this.currentObservation.frame;
    let frames = this.currentObservation.frames ?? [];
    if (parsed.frame !== undefined) {
      const jpeg = Buffer.from(parsed.frame.jpegBase64, "base64");
      const nextFrame = {
        streamKey: parsed.frame.streamKey,
        userId: parsed.frame.userId,
        width: parsed.frame.width,
        height: parsed.frame.height,
        jpegBase64: parsed.frame.jpegBase64,
        capturedAt: parsed.frame.capturedAt,
        ...this.writeShareArtifact(jpeg, now),
      };
      frame = nextFrame;
      frames = [...frames.filter((sample) => sample.streamKey === nextFrame.streamKey), nextFrame].slice(
        -DISCORD_STREAM_WATCH_FRAME_HISTORY_MAX,
      );
    }
    const merged = mergeStreams(this.bySource);
    const keepKey = frame?.streamKey;
    if (keepKey !== undefined && !merged.some((stream) => stream.streamKey === keepKey)) {
      frame = undefined;
      frames = [];
    }

    this.currentObservation = DiscordStreamWatchObservationSchema.parse({
      schemaVersion: 1,
      streams: merged,
      ...(frame === undefined ? {} : { frame }),
      ...(frames.length === 0 ? {} : { frames }),
      decoder: parsed.decoder ?? this.currentObservation.decoder,
      ...(parsed.decoderDetail === undefined ? {} : { decoderDetail: parsed.decoderDetail }),
      updatedAt: now.toISOString(),
    });
    if (parsed.frame !== undefined) this.retireStills(now);
    return this.current();
  }

  public current(): DiscordStreamWatchObservation {
    return structuredClone(this.currentObservation);
  }

  private writeShareArtifact(jpeg: Buffer, now: Date): { artifactRef: string } | undefined {
    if (this.artifactRoot === undefined || jpeg.byteLength === 0) return undefined;
    const digest = createHash("sha256").update(jpeg).digest("hex");
    const relativePath = join(SHARE_ARTIFACT_DIRECTORY, `${digest}.jpg`);
    const path = join(this.artifactRoot, relativePath);
    // A still screen repeats its frame: content-addressed, so the file already
    // on disk is this frame, and only its age is refreshed.
    const previous = this.written.get(digest);
    if (previous === undefined || statSync(path, { throwIfNoEntry: false }) === undefined) {
      if (!this.directoryReady) {
        mkdirSync(join(this.artifactRoot, SHARE_ARTIFACT_DIRECTORY), { recursive: true, mode: 0o700 });
        this.directoryReady = true;
      }
      writeFileSync(path, jpeg, { mode: 0o600 });
    }
    this.track(digest, jpeg.byteLength, now.getTime());
    const artifactRef = `sha256:${digest}:${relativePath}`;
    return isShareArtifactRef(artifactRef) ? { artifactRef } : undefined;
  }

  private track(digest: string, bytes: number, writtenAtMs: number): void {
    const previous = this.written.get(digest);
    if (previous !== undefined) {
      this.written.delete(digest);
      this.writtenBytes -= previous.bytes;
    }
    this.written.set(digest, { bytes, writtenAtMs });
    this.writtenBytes += bytes;
  }

  private retireStills(now: Date): void {
    if (this.artifactRoot === undefined) return;
    const shown = new Set(
      [this.currentObservation.frame, ...(this.currentObservation.frames ?? [])].flatMap((frame) => {
        const digest = frame?.artifactRef?.split(":")[1];
        return digest === undefined ? [] : [digest];
      }),
    );
    const expiredBefore = now.getTime() - this.retention.maxAgeMs;
    for (const [digest, still] of this.written) {
      const expired = still.writtenAtMs < expiredBefore;
      if (!expired && this.writtenBytes <= this.retention.maxBytes) break;
      if (shown.has(digest)) continue;
      try {
        unlinkSync(join(this.artifactRoot, SHARE_ARTIFACT_DIRECTORY, `${digest}.jpg`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
      }
      this.written.delete(digest);
      this.writtenBytes -= still.bytes;
    }
  }

  private adoptExistingStills(): void {
    if (this.artifactRoot === undefined) return;
    const directory = join(this.artifactRoot, SHARE_ARTIFACT_DIRECTORY);
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      return;
    }
    this.directoryReady = true;
    const stills = names.flatMap((name) => {
      const match = /^([0-9a-f]{64})\.jpg$/u.exec(name);
      const stats = match === null ? undefined : statSync(join(directory, name), { throwIfNoEntry: false });
      return match === null || stats === undefined || !stats.isFile()
        ? []
        : [{ digest: match[1]!, bytes: stats.size, writtenAtMs: stats.mtimeMs }];
    });
    stills.sort((a, b) => a.writtenAtMs - b.writtenAtMs);
    for (const still of stills) this.track(still.digest, still.bytes, still.writtenAtMs);
    this.retireStills(new Date());
  }
}

function mergeStreams(
  bySource: Map<"bot" | "user_session", DiscordStreamWatchReport["streams"]>,
): DiscordStreamWatchReport["streams"] {
  const merged = new Map<string, DiscordStreamWatchReport["streams"][number]>();
  for (const source of ["bot", "user_session"] as const) {
    for (const stream of bySource.get(source) ?? []) {
      const existing = merged.get(stream.streamKey);
      merged.set(stream.streamKey, {
        ...stream,
        watching: stream.watching || existing?.watching === true,
        hasFrame: stream.hasFrame || existing?.hasFrame === true,
      });
    }
  }
  return [...merged.values()];
}
