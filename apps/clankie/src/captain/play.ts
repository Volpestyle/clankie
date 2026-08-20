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

export interface PlayAskContext {
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
export function defaultPlayBudget(env: NodeJS.ProcessEnv = process.env): EmbodimentBudget {
  const turns = Number.parseInt(env["CLANKIE_PLAY_MAX_TURNS"] ?? "", 10);
  const durationMs = Number.parseInt(env["CLANKIE_PLAY_MAX_DURATION_MS"] ?? "", 10);
  return {
    ...(Number.isSafeInteger(turns) && turns > 0 ? { maxTurns: turns } : {}),
    ...(Number.isSafeInteger(durationMs) && durationMs > 0 ? { maxDurationMs: durationMs } : {}),
  };
}

export async function startPlay(ports: PlayPorts, input: StartPlayInput): Promise<EmbodimentPlayNote> {
  return submitStart(ports, input);
}

/** Ask to join a hosted world; the venue selects the body behind the same lifecycle. */
export function joinWorld(ports: PlayPorts, input: StartPlayInput): Promise<EmbodimentPlayNote> {
  return submitStart(ports, input, "world");
}

async function submitStart(
  ports: PlayPorts,
  input: StartPlayInput,
  venue?: "world",
): Promise<EmbodimentPlayNote> {
  const joining = venue === "world";
  const intentId = `${joining ? "world" : "play"}-${randomUUID()}`;
  const submitted = await ports.submitEmbodimentIntent({
    kind: "start",
    schemaVersion: 1,
    intentId,
    originLane: input.originLane,
    requestedBy: input.requestedBy,
    requestedAt: new Date().toISOString(),
    environmentId: input.environmentId,
    budget: input.budget ?? defaultPlayBudget(),
    ...(venue === undefined ? {} : { venue }),
  });
  if (submitted.outcome === "refused") {
    return {
      action: joining ? "join_refused" : "start_refused",
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
      return joining
        ? { action: "joined" as const, sessionId, environmentId: session.environmentId }
        : {
            action: "started" as const,
            sessionId,
            environmentId: session.environmentId,
            ...(session.resumedFromCheckpointId === undefined
              ? {}
              : { resumedFromCheckpointId: session.resumedFromCheckpointId }),
          };
    }
    if (session.state === "refused") {
      return {
        action: joining ? ("join_refused" as const) : ("start_refused" as const),
        environmentId: session.environmentId,
        reason: session.refusalReason ?? (joining ? "world_unreachable" : "environment_unavailable"),
      };
    }
    if (session.state === "failed") {
      return {
        action: joining ? ("join_refused" as const) : ("start_refused" as const),
        environmentId: session.environmentId,
        reason: joining ? ("world_unreachable" as const) : ("environment_unavailable" as const),
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
      return {
        action: "stopped" as const,
        sessionId,
        ...(session.checkpointId === undefined ? {} : { checkpointId: session.checkpointId }),
      };
    }
    // Failed after a stop ask still means the playthrough ended; the note stays
    // honest by carrying no checkpoint.
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
