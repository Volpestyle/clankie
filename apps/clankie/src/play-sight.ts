/**
 * In-process pull-when-he-wants sight of the live playthrough (ADR 0099).
 *
 * The play host registers a live capture and the current journal path while
 * the body is running. HTTP and captain tools read this; they never reach
 * into the emulator themselves.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseFreePlayJournal, projectPlayStory } from "@clankie/gba-emulator";
import {
  PlayStillReadSchema,
  PlayStoryReadSchema,
  type PlayStillRead,
  type PlayStoryCard,
  type PlayStoryRead,
} from "@clankie/interactive-environment";
import type { EmbodimentEnvironmentId } from "@clankie/protocol";

export interface PlayStillCapture {
  png: Buffer;
  width: number;
  height: number;
}

export interface PlaySightAttach {
  readonly sessionId: string;
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

export interface PlaySightPort {
  still(): PlayStillRead;
  story(): PlayStoryRead;
}

export class PlaySightProjection implements PlaySightPort {
  private attached: PlaySightAttach | undefined;
  private progress: PlaySightProgress | undefined;

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
      return PlayStoryReadSchema.parse({ schemaVersion: 1, outcome: "not_playing" });
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
    let contents: string;
    try {
      contents = readFileSync(attached.journalPath, "utf8");
    } catch {
      return undefined;
    }
    try {
      return projectPlayStory({
        sessionId: attached.sessionId,
        environmentId: attached.environmentId,
        lines: parseFreePlayJournal(contents),
        ...(this.progress === undefined ? {} : { maps: this.progress.maps }),
      });
    } catch {
      return undefined;
    }
  }
}
