/**
 * In-process pull-when-he-wants sight of the current or latest play journey
 * (ADR 0099 / ADR 0126).
 *
 * The play host registers a live capture and the current journal path while
 * the body is running. HTTP and captain tools read this; they never reach
 * into the world themselves.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  listPlayJourneyRuns,
  parseFreePlayJournal,
  projectPlayStory,
  type PlayJourneyId,
} from "@clankie/play";
import {
  PlayStillReadSchema,
  PlayStoryReadSchema,
  type PlayStillRead,
  type PlayStoryCard,
  type PlayStoryRead,
} from "@clankie/interactive-environment";
import type { EmbodimentEnvironmentId } from "@clankie/protocol";

interface PlayStillCapture {
  png: Buffer;
  width: number;
  height: number;
}

export interface PlaySightAttach {
  readonly sessionId: string;
  readonly journeyId: PlayJourneyId;
  readonly environmentId: EmbodimentEnvironmentId;
  readonly scenarioId: string;
  readonly startedAt: string;
  readonly journalPath?: string;
  readonly capture: () => PlayStillCapture | undefined;
}

export interface PlaySightProgress {
  readonly maps: readonly string[];
  readonly objective: string | null;
}

interface PlaySightPort {
  still(): PlayStillRead;
  story(): PlayStoryRead;
}

export class PlaySightProjection implements PlaySightPort {
  private readonly journalRootDir: string | undefined;
  private attached: PlaySightAttach | undefined;
  private progress: PlaySightProgress | undefined;

  public constructor(options: { journalRootDir?: string } = {}) {
    this.journalRootDir = options.journalRootDir;
  }

  public attach(session: PlaySightAttach): void {
    this.attached = session;
    this.progress = undefined;
  }

  public noteProgress(progress: PlaySightProgress): void {
    if (this.attached === undefined) return;
    this.progress = {
      maps: [...progress.maps],
      objective: progress.objective,
    };
  }

  public detach(sessionId: string): void {
    if (this.attached?.sessionId === sessionId) {
      this.attached = undefined;
      this.progress = undefined;
    }
  }

  public still(): PlayStillRead {
    const attached = this.attached;
    if (attached === undefined) {
      return PlayStillReadSchema.parse({ schemaVersion: 1, outcome: "not_playing" });
    }
    const captured = attached.capture();
    if (captured === undefined) {
      return PlayStillReadSchema.parse({
        schemaVersion: 1,
        outcome: "pending",
        sessionId: attached.sessionId,
        environmentId: attached.environmentId,
      });
    }
    return PlayStillReadSchema.parse({
      schemaVersion: 1,
      outcome: "still",
      sessionId: attached.sessionId,
      environmentId: attached.environmentId,
      mimeType: "image/png",
      width: captured.width,
      height: captured.height,
      sha256: createHash("sha256").update(captured.png).digest("hex"),
      capturedAt: new Date().toISOString(),
      pngBase64: captured.png.toString("base64"),
    });
  }

  public story(): PlayStoryRead {
    const attached = this.attached;
    if (attached === undefined) {
      const card = this.readLatestCard();
      return card === undefined
        ? PlayStoryReadSchema.parse({ schemaVersion: 1, outcome: "not_playing" })
        : PlayStoryReadSchema.parse({ schemaVersion: 1, outcome: "card", card });
    }
    const card = this.readCard(attached);
    if (card === undefined) {
      return PlayStoryReadSchema.parse({
        schemaVersion: 1,
        outcome: "pending",
        sessionId: attached.sessionId,
        environmentId: attached.environmentId,
      });
    }
    return PlayStoryReadSchema.parse({ schemaVersion: 1, outcome: "card", card });
  }

  private readCard(attached: PlaySightAttach): PlayStoryCard | undefined {
    if (attached.journalPath === undefined) return undefined;
    try {
      const historical =
        this.journalRootDir === undefined
          ? []
          : listPlayJourneyRuns(this.journalRootDir, attached.journeyId).flatMap((run) => run.lines);
      const lines =
        historical.length > 0 ? historical : parseFreePlayJournal(readFileSync(attached.journalPath, "utf8"));
      return projectPlayStory({
        sessionId: attached.sessionId,
        environmentId: attached.environmentId,
        lines,
        ...(this.progress === undefined ? {} : { maps: this.progress.maps }),
      });
    } catch {
      return undefined;
    }
  }

  private readLatestCard(): PlayStoryCard | undefined {
    if (this.journalRootDir === undefined) return undefined;
    const runs = listPlayJourneyRuns(this.journalRootDir);
    const latest = runs.at(-1);
    if (latest === undefined) return undefined;
    const lines = runs
      .filter((run) => run.header.journeyId === latest.header.journeyId)
      .flatMap((run) => run.lines);
    try {
      return projectPlayStory({
        sessionId: latest.header.runId,
        environmentId: latest.header.environmentId,
        lines,
      });
    } catch {
      return undefined;
    }
  }
}
