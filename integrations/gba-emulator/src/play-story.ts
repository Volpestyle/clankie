/**
 * Bounded story card from a play journal (ADR 0099).
 *
 * The journal is the trail. This projection is what a mouth or a captain
 * may read: objective, maps, and the last few moments he judged worth a
 * remark. Monologue, notes, and button-level telemetry stay off the card.
 */
import {
  PLAY_STORY_MAPS_MAX,
  PLAY_STORY_MOMENTS_MAX,
  PlayStoryCardSchema,
  type PlayStoryCard,
  type PlayStoryMoment,
} from "@clankie/interactive-environment";
import type { EmbodimentEnvironmentId } from "@clankie/protocol";
import type { FreePlayJournalLine } from "./free-play-journal.ts";

export interface ProjectPlayStoryInput {
  readonly sessionId: string;
  readonly environmentId: EmbodimentEnvironmentId;
  readonly lines: readonly FreePlayJournalLine[];
  /** Latest runner-observed maps; the journal does not store them per turn. */
  readonly maps?: readonly string[];
}

export function projectPlayStory(input: ProjectPlayStoryInput): PlayStoryCard {
  const header = input.lines.find((line) => line.kind === "header");
  if (header === undefined || header.kind !== "header") {
    throw new Error("play_story_missing_header");
  }
  const turns = input.lines.filter((line) => line.kind === "turn");
  const last = turns.at(-1);
  const moments: PlayStoryMoment[] = [];
  for (const line of turns) {
    if (line.kind !== "turn" || !line.turn.speakWanted) continue;
    const effect = line.turn.effect?.trim();
    if (effect === undefined || effect.length === 0) continue;
    const toward = line.turn.objective?.trim();
    moments.push({
      at: line.at,
      effect,
      toward: toward === undefined || toward.length === 0 ? null : toward.slice(0, 160),
    });
  }
  let summaryMaps: readonly string[] | undefined;
  for (let index = input.lines.length - 1; index >= 0; index -= 1) {
    const line = input.lines[index];
    if (line !== undefined && line.kind === "summary") {
      summaryMaps = line.progress.maps;
      break;
    }
  }
  const maps = input.maps ?? summaryMaps ?? [];
  return PlayStoryCardSchema.parse({
    schemaVersion: 1,
    sessionId: input.sessionId,
    environmentId: input.environmentId,
    scenarioId: header.scenarioId,
    startedAt: header.startedAt,
    turnsTaken: turns.length,
    lastTurnAt: last?.kind === "turn" ? last.at : null,
    objective: last?.kind === "turn" ? last.turn.objective?.trim().slice(0, 160) || null : null,
    maps: maps.slice(-PLAY_STORY_MAPS_MAX).map((mapId) => mapId.slice(0, 200)),
    moments: moments.slice(-PLAY_STORY_MOMENTS_MAX),
  });
}
