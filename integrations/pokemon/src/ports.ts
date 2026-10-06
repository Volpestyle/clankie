import type { GameRunControl } from "@clankie/game-extension";
import type { ActivityObservationSnapshot } from "@clankie/interactive-environment";
import type { EmbodimentSession, EmbodimentRefusalReason, EmbodimentSessionOutcome } from "@clankie/protocol";
import type { PlayJourneyId } from "@clankie/play";

export type PokemonPlayResult =
  | { kind: "refused"; reason: EmbodimentRefusalReason }
  | {
      kind: "ran";
      result: {
        outcome: EmbodimentSessionOutcome;
        turnsTaken: number;
        durationMs: number;
        framesPublished: number;
        framesDropped: number;
      };
    };
export type PokemonPlayExecution = (
  session: EmbodimentSession,
  control: GameRunControl,
  onRunning: () => Promise<void>,
) => Promise<PokemonPlayResult>;
export interface ActivityObservationWritePort {
  publish(candidate: ActivityObservationSnapshot): ActivityObservationSnapshot;
  clear(sessionId: string): void;
}
export interface PokemonSightPort {
  attach(session: {
    sessionId: string;
    journeyId: PlayJourneyId;
    environmentId: EmbodimentSession["environmentId"];
    scenarioId: string;
    startedAt: string;
    journalPath?: string;
    capture(): { png: Buffer; width: number; height: number } | undefined;
  }): void;
  noteProgress(progress: { maps: readonly string[]; objective: string | null }): void;
  detach(sessionId: string): void;
}
