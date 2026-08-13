import { randomUUID } from "node:crypto";
import { ClankieApiClient } from "@clankie/api-client";
import type { CaptainEpisode, CaptainEpisodeVisibility, CaptainSessionLaneV2 } from "@clankie/protocol";
import { captainLaneKind, type EveChannelLaneContext } from "./lanes/context.ts";
import { captainLaneRuntime } from "./lanes/runtime.ts";

/**
 * Recall runs on every turn, so a control plane that accepts the connection and
 * then never answers must not be able to wedge the conversation. `ClankieApiClient`
 * applies no timeout of its own — deliberately, since `observeMissionEvents` is a
 * long-lived stream — so the bound belongs here, on these two calls.
 *
 * Catching errors is not sufficient on its own: a hang raises nothing to catch,
 * and an instruction hook that never resolves is indistinguishable from a captain
 * that has stopped answering.
 */
const RECALL_TIMEOUT_MS = 2_000;
const RECORD_TIMEOUT_MS = 5_000;

export interface EpisodeTransportOptions {
  readonly fetchImpl?: typeof fetch;
}

function boundedControlPlaneClient(
  timeoutMs: number,
  options: EpisodeTransportOptions = {},
): ClankieApiClient {
  const transport = options.fetchImpl ?? fetch;
  return new ClankieApiClient({
    baseUrl: process.env.CLANKIE_CONTROL_PLANE_URL ?? "http://127.0.0.1:4310",
    ...(process.env.CLANKIE_CAPTAIN_TOKEN ? { captainToken: process.env.CLANKIE_CAPTAIN_TOKEN } : {}),
    fetchImpl: (input, init) => transport(input, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  });
}

/**
 * The default scope for a note, by the room it was written in.
 *
 * Only the operator lane holds anything private, so only it defaults closed.
 * The Discord and gameplay lanes default open: a note written in a public room
 * describes something that room already watched him do, and keeping it from
 * resurfacing there would be the amnesia this exists to fix.
 */
function defaultVisibility(lane: CaptainSessionLaneV2): CaptainEpisodeVisibility {
  return lane === "operator" ? "operator_private" : "shareable";
}

/** Bounded, safe, non-fatal line. Never the raw error, which could echo turn content. */
function reportEpisodeError(operation: string, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      service: "captain-eve",
      event: `captain_episode.${operation}_failed`,
      errorName: error instanceof Error ? error.name.slice(0, 64) : "Error",
    })}\n`,
  );
}

export interface RememberedEpisodeNote {
  readonly summary: string;
  readonly visibility?: CaptainEpisodeVisibility | undefined;
}

/**
 * Injectable core: stamps a composed note with the room it actually happened in.
 *
 * The lane and target come from the authenticated channel, never from the tool
 * arguments, so a Discord turn cannot file an episode as an operator one.
 */
export function buildCaptainEpisode(input: {
  readonly channel: EveChannelLaneContext;
  readonly sessionId: string;
  readonly characterId: string;
  readonly episodeId: string;
  readonly note: RememberedEpisodeNote;
  readonly occurredAt: string;
}): CaptainEpisode {
  const lane = captainLaneKind(input.channel);
  const target = input.channel.metadata?.captainTargetId;
  return {
    schemaVersion: 1,
    episodeId: input.episodeId,
    lane,
    targetId: typeof target === "string" && target.trim().length > 0 ? target.trim() : lane,
    summary: input.note.summary,
    visibility: input.note.visibility ?? defaultVisibility(lane),
    provenance: {
      characterId: input.characterId,
      sessionId: input.sessionId,
      selfAuthored: true,
      rawTranscript: false,
    },
    occurredAt: input.occurredAt,
  };
}

/** Stamps a composed note and records it through the control plane. */
export async function recordCaptainEpisode(input: {
  readonly channel: EveChannelLaneContext;
  readonly sessionId: string;
  readonly note: RememberedEpisodeNote;
  readonly occurredAt: string;
}): Promise<CaptainEpisode | undefined> {
  const runtime = await captainLaneRuntime();
  const episode = buildCaptainEpisode({
    ...input,
    characterId: runtime.identity.characterId,
    episodeId: randomUUID(),
  });
  try {
    await boundedControlPlaneClient(RECORD_TIMEOUT_MS).recordCaptainEpisode(episode);
    return episode;
  } catch (error) {
    // Losing a note must never take down the turn that wrote it.
    reportEpisodeError("record", error);
    return undefined;
  }
}

/**
 * What he remembers doing elsewhere, scoped to this room.
 *
 * Fails open to silence rather than throwing: an instruction hook that throws
 * takes the whole turn down, and a missing memory is a far smaller failure than
 * a dead conversation.
 */
export async function captainEpisodeInstructions(
  channel: EveChannelLaneContext,
  options: EpisodeTransportOptions = {},
): Promise<string> {
  try {
    const lane = captainLaneKind(channel);
    const { recallCard } = await boundedControlPlaneClient(RECALL_TIMEOUT_MS, options).recallCaptainEpisodes(
      lane,
    );
    return recallCard;
  } catch (error) {
    reportEpisodeError("recall", error);
    return "";
  }
}
