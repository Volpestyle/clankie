import type { DiscordStreamWatchObservation, DiscordStreamWatchReport } from "@clankie/protocol";

/** World's stream observations; an absent World has no streams (ADR 0328). */
export interface StreamWatchPort {
  apply(report: DiscordStreamWatchReport, now?: Date): DiscordStreamWatchObservation;
  current(): DiscordStreamWatchObservation;
}

export function absentStreamWatch(): StreamWatchPort {
  return {
    apply: () => {
      throw new Error("world_unavailable");
    },
    current: () => ({ schemaVersion: 1, streams: [], decoder: "idle" }),
  };
}
