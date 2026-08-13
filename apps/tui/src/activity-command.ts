import type { ActivityObservationRead } from "@clankie/api-client";

export interface ActivityObservationClient {
  getCurrentActivityObservation(): Promise<ActivityObservationRead>;
}

export interface ActivityDisplayOptions {
  readonly watchUrl?: string;
}

/** Render the bounded semantic projection; live frame bytes stay on the watch surface. */
export function formatActivityObservation(
  read: ActivityObservationRead,
  options: ActivityDisplayOptions = {},
): string {
  const watch = options.watchUrl === undefined ? [] : [`watch: ${safe(options.watchUrl)}`];
  if (read.outcome === "not_playing") {
    return ["No activity is running right now.", ...watch].join("\n");
  }
  if (read.outcome === "pending") {
    return [
      `${gameName(read.environmentId)} · starting`,
      `session: ${safe(read.sessionId)}`,
      `state: ${safe(read.state)} · waiting for the first settled turn`,
      `updated: ${safe(read.updatedAt)}`,
      ...watch,
    ].join("\n");
  }

  const snapshot = read.snapshot;
  const authored = snapshot.selfAuthored;
  const observed = snapshot.runnerObserved;
  const maps = observed.progress.maps.slice(0, 6).map(safe);
  const remainingMaps = observed.progress.maps.length - maps.length;
  const mapSummary =
    maps.length === 0 ? "none yet" : `${maps.join(", ")}${remainingMaps > 0 ? ` +${remainingMaps}` : ""}`;
  return [
    `${gameName(snapshot.environmentId)} · playing`,
    `latest settled turn: #${snapshot.sequence}`,
    `goal (Clankie-authored): ${present(authored.objective)}`,
    `commentary (Clankie-authored): ${present(authored.commentary)}`,
    `next move (Clankie-authored): ${present(authored.intent)}`,
    `last result (runner-observed): ${safe(observed.outcome)}`,
    `effect (runner-observed): ${present(observed.effect)}`,
    `exploration (runner-observed): ${observed.progress.distinctTiles} distinct tiles · maps ${mapSummary}`,
    `pace (runner-observed): ${formatPace(observed.progress.actionsPerNewTile)} · ${observed.progress.turnsSinceNewTile} turns since a new tile`,
    `observed: ${safe(snapshot.observedAt)}`,
    ...watch,
  ].join("\n");
}

function gameName(environmentId: string): string {
  return environmentId === "pokemon-emerald" ? "Pokémon Emerald" : "Pokémon FireRed";
}

function present(value: string | null): string {
  return value === null || value.trim().length === 0 ? "—" : safe(value);
}

function formatPace(actionsPerNewTile: number | null): string {
  return actionsPerNewTile === null ? "pace unavailable" : `${actionsPerNewTile.toFixed(2)} actions/new tile`;
}

/** Model-authored fields are data, never terminal control sequences. */
function safe(value: string): string {
  // oxlint-disable-next-line no-control-regex -- terminal output must strip every C0/C1 control
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").trim();
}
