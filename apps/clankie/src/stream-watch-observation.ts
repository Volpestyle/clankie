import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DiscordStreamWatchObservationSchema,
  DiscordStreamWatchReportSchema,
  SHARE_ARTIFACT_DIRECTORY,
  isShareArtifactRef,
  type DiscordStreamWatchObservation,
  type DiscordStreamWatchReport,
} from "@clankie/protocol";

/**
 * Latest-only view of Discord screen shares.
 *
 * Memory-first: raw video never enters the event log. A still is optional and
 * is written under `shares/` only when an attachment root is configured, so
 * `observe_share` can harvest it the same way a browser screenshot is harvested.
 */
export class DiscordStreamWatchProjection {
  private readonly artifactRoot: string | undefined;
  private readonly bySource = new Map<"bot" | "user_session", DiscordStreamWatchReport["streams"]>();
  private currentObservation: DiscordStreamWatchObservation = {
    schemaVersion: 1,
    streams: [],
    decoder: "idle",
  };

  public constructor(artifactRoot?: string) {
    this.artifactRoot = artifactRoot;
  }

  public apply(report: DiscordStreamWatchReport, now: Date = new Date()): DiscordStreamWatchObservation {
    const parsed = DiscordStreamWatchReportSchema.parse(report);
    this.bySource.set(parsed.source, parsed.streams);

    let frame = this.currentObservation.frame;
    if (parsed.frame !== undefined) {
      const jpeg = Buffer.from(parsed.frame.jpegBase64, "base64");
      frame = {
        streamKey: parsed.frame.streamKey,
        userId: parsed.frame.userId,
        width: parsed.frame.width,
        height: parsed.frame.height,
        jpegBase64: parsed.frame.jpegBase64,
        capturedAt: parsed.frame.capturedAt,
        ...this.writeShareArtifact(jpeg),
      };
    }
    const merged = mergeStreams(this.bySource);
    const keepKey = frame?.streamKey;
    if (keepKey !== undefined && !merged.some((stream) => stream.streamKey === keepKey)) {
      frame = undefined;
    }

    this.currentObservation = DiscordStreamWatchObservationSchema.parse({
      schemaVersion: 1,
      streams: merged,
      ...(frame === undefined ? {} : { frame }),
      decoder: parsed.decoder ?? this.currentObservation.decoder,
      ...(parsed.decoderDetail === undefined ? {} : { decoderDetail: parsed.decoderDetail }),
      updatedAt: now.toISOString(),
    });
    return this.current();
  }

  public current(): DiscordStreamWatchObservation {
    return structuredClone(this.currentObservation);
  }

  private writeShareArtifact(jpeg: Buffer): { artifactRef: string } | undefined {
    if (this.artifactRoot === undefined || jpeg.byteLength === 0) return undefined;
    const digest = createHash("sha256").update(jpeg).digest("hex");
    const relativePath = join(SHARE_ARTIFACT_DIRECTORY, `${digest}.jpg`);
    const directory = join(this.artifactRoot, SHARE_ARTIFACT_DIRECTORY);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.artifactRoot, relativePath), jpeg, { mode: 0o600 });
    const artifactRef = `sha256:${digest}:${relativePath}`;
    return isShareArtifactRef(artifactRef) ? { artifactRef } : undefined;
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
