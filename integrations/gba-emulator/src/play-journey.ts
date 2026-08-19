/**
 * Cross-run continuity projected from the play journals.
 *
 * Checkpoints own exact world state and journals own the durable trail. This
 * module only finds the runs belonging to one stable adventure and recovers
 * the last notes/objective the player wrote; it creates no competing store.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { EmbodimentEnvironmentId } from "@clankie/protocol";
import {
  FreePlayJournalHeaderV3Schema,
  PlayJourneyIdSchema,
  parseFreePlayJournal,
  type FreePlayJournalHeader,
  type FreePlayJournalLine,
  type PlayJourneyId,
} from "./free-play-journal.ts";

export interface PlayJourneyRun {
  readonly path: string;
  readonly header: Extract<FreePlayJournalHeader, { schemaVersion: 3 }>;
  readonly lines: readonly FreePlayJournalLine[];
}

export interface PlayJourneyContinuity {
  readonly notes: string | null;
  readonly objective: string | null;
}

export function localPlayJourneyId(input: {
  environmentId: EmbodimentEnvironmentId;
  profileId?: string | undefined;
}): PlayJourneyId {
  const profileId = input.profileId ?? "main";
  return PlayJourneyIdSchema.parse(`local:${input.environmentId}:profile:${encodeURIComponent(profileId)}`);
}

export function worldPlayJourneyId(input: { worldId: string; playerId: string }): PlayJourneyId {
  return PlayJourneyIdSchema.parse(
    `world:${encodeURIComponent(input.worldId)}:player:${encodeURIComponent(input.playerId)}`,
  );
}

/** Valid V3 journals, oldest first. A corrupt/unrelated file is not a journey. */
export function listPlayJourneyRuns(rootDir: string, journeyId?: PlayJourneyId): PlayJourneyRun[] {
  // ponytail: session-boundary/explicit-recall scans are the current scale ceiling; add a
  // rebuildable per-journey index only when journal volume makes these reads measurably slow.
  let entries: string[];
  try {
    entries = readdirSync(rootDir).filter((entry) => entry.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const runs: PlayJourneyRun[] = [];
  for (const entry of entries) {
    try {
      const journalPath = path.join(rootDir, entry);
      const lines = parseFreePlayJournal(readFileSync(journalPath, "utf8"));
      const header = FreePlayJournalHeaderV3Schema.safeParse(lines[0]);
      if (!header.success || (journeyId !== undefined && header.data.journeyId !== journeyId)) continue;
      runs.push({ path: journalPath, header: header.data, lines });
    } catch {
      // The journal parser deliberately rejects corrupt evidence. One bad run
      // cannot erase every other run from the bounded recall projection.
    }
  }
  return runs.sort(
    (left, right) =>
      left.header.startedAt.localeCompare(right.header.startedAt) ||
      left.header.runId.localeCompare(right.header.runId),
  );
}

export function latestPlayJourneyContinuity(
  rootDir: string,
  journeyId: PlayJourneyId,
): PlayJourneyContinuity | null {
  const runs = listPlayJourneyRuns(rootDir, journeyId);
  for (let runIndex = runs.length - 1; runIndex >= 0; runIndex -= 1) {
    const lines = runs[runIndex]?.lines ?? [];
    for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
      const line = lines[lineIndex];
      if (line?.kind === "turn") {
        return { notes: line.turn.notes ?? null, objective: line.turn.objective ?? null };
      }
    }
  }
  return null;
}
