/**
 * Asked play (ADR 0063), captain side: submit the intent, wait bounded for the
 * local play host's answer, and return the typed note his reply renders. The captain
 * holds nothing but the ask — no emulator import, no process, no credential.
 *
 * The bounded wait is what keeps the reply honest: "started" is only said
 * after the play host reaches running, and past the bound the note is `pending`,
 * which he must voice as "starting it up", never "I'm playing".
 */
import { randomUUID } from "node:crypto";
import type {
  CaptainSessionLaneV2,
  EmbodimentBudget,
  EmbodimentEnvironmentId,
  EmbodimentIntent,
  EmbodimentPlayNote,
  EmbodimentSession,
  EmbodimentSubmitResult,
} from "@clankie/protocol";

export interface PlayPorts {
  submitEmbodimentIntent(intent: EmbodimentIntent): Promise<EmbodimentSubmitResult>;
  getEmbodimentSession(sessionId: string): Promise<EmbodimentSession | undefined>;
  getLiveEmbodimentSession(): Promise<EmbodimentSession | undefined>;
}

interface PlayAskContext {
  /** The surface the ask came from; bounded telemetry, never authority. */
  originLane: CaptainSessionLaneV2;
  /** The asker as the surface authenticated them; a content-free id. */
  requestedBy: string;
}

export interface StartPlayInput extends PlayAskContext {
  environmentId: EmbodimentEnvironmentId;
  budget?: EmbodimentBudget;
  waitMs?: number;
  pollMs?: number;
}

const DEFAULT_WAIT_MS = 12_000;
const DEFAULT_POLL_MS = 400;

/**
 * The owner's default (2026-07-26): no cap on turns or duration — he plays
 * until asked to stop. The env knobs restore a cap when one is wanted.
 */
function defaultPlayBudget(env: NodeJS.ProcessEnv = process.env): EmbodimentBudget {
  const turns = Number.parseInt(env["CLANKIE_PLAY_MAX_TURNS"] ?? "", 10);
  const durationMs = Number.parseInt(env["CLANKIE_PLAY_MAX_DURATION_MS"] ?? "", 10);
  return {
    ...(Number.isSafeInteger(turns) && turns > 0 ? { maxTurns: turns } : {}),
    ...(Number.isSafeInteger(durationMs) && durationMs > 0 ? { maxDurationMs: durationMs } : {}),
  };
}

/** Ask to join the hosted world — the only body he has. */
export async function joinWorld(ports: PlayPorts, input: StartPlayInput): Promise<EmbodimentPlayNote> {
  const intentId = `world-${randomUUID()}`;
  const submitted = await ports.submitEmbodimentIntent({
    kind: "start",
    schemaVersion: 1,
    intentId,
    originLane: input.originLane,
    requestedBy: input.requestedBy,
    requestedAt: new Date().toISOString(),
    environmentId: input.environmentId,
    budget: input.budget ?? defaultPlayBudget(),
  });
  if (submitted.outcome === "refused") {
    return {
      action: "join_refused",
      environmentId: input.environmentId,
      reason: submitted.reason,
    };
  }
  if (submitted.outcome !== "accepted") {
    // A start never answers "stop_requested"; treat a confused wire as pending.
    return { action: "pending", intentId };
  }
  const sessionId = submitted.session.sessionId;
  const outcome = await waitForSession(ports, sessionId, input.waitMs, input.pollMs, (session) => {
    if (session.state === "running") {
      return { action: "joined" as const, sessionId, environmentId: session.environmentId };
    }
    if (session.state === "refused") {
      return {
        action: "join_refused" as const,
        environmentId: session.environmentId,
        reason: session.refusalReason ?? "world_unreachable",
      };
    }
    if (session.state === "failed") {
      return {
        action: "join_refused" as const,
        environmentId: session.environmentId,
        reason: "world_unreachable" as const,
      };
    }
    return undefined;
  });
  return outcome ?? { action: "pending", intentId: submitted.session.intentId };
}

export interface StopPlayInput extends PlayAskContext {
  waitMs?: number;
  pollMs?: number;
}

export async function stopPlay(ports: PlayPorts, input: StopPlayInput): Promise<EmbodimentPlayNote> {
  let live: EmbodimentSession | undefined;
  try {
    live = await ports.getLiveEmbodimentSession();
  } catch {
    live = undefined;
  }
  if (live === undefined) {
    return { action: "stop_refused", reason: "not_playing" };
  }
  const intentId = `play-stop-${randomUUID()}`;
  const submitted = await ports.submitEmbodimentIntent({
    kind: "stop",
    schemaVersion: 1,
    intentId,
    originLane: input.originLane,
    requestedBy: input.requestedBy,
    requestedAt: new Date().toISOString(),
    sessionId: live.sessionId,
  });
  if (submitted.outcome === "refused") {
    return { action: "stop_refused", sessionId: live.sessionId, reason: submitted.reason };
  }
  const sessionId = live.sessionId;
  const outcome = await waitForSession(ports, sessionId, input.waitMs, input.pollMs, (session) => {
    if (session.state === "stopped") {
      return { action: "stopped" as const, sessionId };
    }
    // Failed after a stop ask still means the playthrough ended.
    if (session.state === "failed" || session.state === "refused") {
      return { action: "stopped" as const, sessionId };
    }
    return undefined;
  });
  return outcome ?? { action: "pending", intentId };
}

async function waitForSession(
  ports: PlayPorts,
  sessionId: string,
  waitMs: number | undefined,
  pollMs: number | undefined,
  settle: (session: EmbodimentSession) => EmbodimentPlayNote | undefined,
): Promise<EmbodimentPlayNote | undefined> {
  const deadline = Date.now() + (waitMs ?? DEFAULT_WAIT_MS);
  const interval = pollMs ?? DEFAULT_POLL_MS;
  for (;;) {
    let session: EmbodimentSession | undefined;
    try {
      session = await ports.getEmbodimentSession(sessionId);
    } catch {
      session = undefined;
    }
    if (session !== undefined) {
      const note = settle(session);
      if (note !== undefined) return note;
    }
    if (Date.now() + interval > deadline) return undefined;
    await new Promise<void>((tick) => {
      const timer = setTimeout(tick, interval);
      timer.unref?.();
    });
  }
}
