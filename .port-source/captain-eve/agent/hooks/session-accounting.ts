import { defineHook, type StreamEventHooks } from "eve/hooks";
import { modelSelectionForTurn } from "../../lib/session/model-selection.ts";
import { captainSessionLedger } from "../../lib/session/runtime.ts";
import { normalizeTokenUsage } from "../../lib/session/token-usage.ts";

/** Injectable clock so the dispatch-time fallback is deterministic under test. */
export type Clock = () => string;

const systemClock: Clock = () => new Date().toISOString();

/**
 * Durable timing for an accounting event.
 *
 * eve 0.22.4's `emit()` writes the timestamped event to the durable stream
 * (`timestampHandleMessageStreamEvent` sets `meta.at`), but returns the
 * un-timestamped event to `dispatchStreamEventHooks`, so stream-event hooks
 * never observe `meta.at`. Hook dispatch runs synchronously immediately after
 * that stream write, so a dispatch-time capture is within milliseconds of, and
 * monotonically consistent with, the stream-persisted timestamp. The accounting
 * guarantee — every ledger entry carries a real ISO-8601 timestamp — is
 * preserved: we prefer the durable `meta.at` when a dispatch path supplies it,
 * and otherwise derive an equally durable timestamp at dispatch rather than
 * recording accounting with no timing metadata.
 */
export function occurredAt(
  event: { readonly meta?: { readonly at?: string | undefined } | undefined },
  now: Clock = systemClock,
): string {
  const durable = event.meta?.at;
  if (typeof durable === "string" && durable.length > 0) return durable;
  return now();
}

export const events: StreamEventHooks = {
  "session.started": async (event, ctx) => {
    const ledger = await captainSessionLedger();
    await ledger.recordStarted(ctx.session.id, "session.started", occurredAt(event), ctx.session.turn.id);
  },
  "turn.started": async (event, ctx) => {
    const ledger = await captainSessionLedger();
    await ledger.recordTurnStarted(
      ctx.session.id,
      `turn:${event.data.turnId}`,
      occurredAt(event),
      event.data.turnId,
    );
  },
  "step.completed": async (event, ctx) => {
    const ledger = await captainSessionLedger();
    const at = occurredAt(event);
    const eventKey = `${event.data.turnId}:${String(event.data.stepIndex)}`;
    const selection = modelSelectionForTurn(ctx.session.id, event.data.turnId);
    if (selection !== undefined) {
      await ledger.recordModelSelection({
        sessionId: ctx.session.id,
        eventKey: `model:${eventKey}`,
        occurredAt: at,
        turnId: event.data.turnId,
        modelRef: selection.ref,
        ...(selection.budget === undefined ? {} : { budget: selection.budget }),
      });
    }
    await ledger.recordUsage({
      sessionId: ctx.session.id,
      eventKey: `usage:${eventKey}`,
      occurredAt: at,
      turnId: event.data.turnId,
      usage: normalizeTokenUsage(event.data.usage),
    });
  },
  "compaction.requested": async (event, ctx) => {
    const ledger = await captainSessionLedger();
    await ledger.recordCompaction({
      sessionId: ctx.session.id,
      eventKey: `requested:${event.data.turnId}:${String(event.data.sequence)}`,
      occurredAt: occurredAt(event),
      turnId: event.data.turnId,
      phase: "requested",
      ...(event.data.usageInputTokens === null ? {} : { usageInputTokens: event.data.usageInputTokens }),
    });
  },
  "compaction.completed": async (event, ctx) => {
    const ledger = await captainSessionLedger();
    await ledger.recordCompaction({
      sessionId: ctx.session.id,
      eventKey: `completed:${event.data.turnId}:${String(event.data.sequence)}`,
      occurredAt: occurredAt(event),
      turnId: event.data.turnId,
      phase: "completed",
    });
  },
  "session.waiting": async (event, ctx) => {
    const ledger = await captainSessionLedger();
    await ledger.recordBoundary({
      sessionId: ctx.session.id,
      eventKey: `waiting:${ctx.session.turn.id}`,
      occurredAt: occurredAt(event),
      turnId: ctx.session.turn.id,
      state: "waiting",
    });
  },
  "session.completed": async (event, ctx) => {
    const ledger = await captainSessionLedger();
    await ledger.recordBoundary({
      sessionId: ctx.session.id,
      eventKey: `completed:${ctx.session.turn.id}`,
      occurredAt: occurredAt(event),
      turnId: ctx.session.turn.id,
      state: "completed",
    });
  },
  "session.failed": async (event, ctx) => {
    const ledger = await captainSessionLedger();
    await ledger.recordBoundary({
      sessionId: ctx.session.id,
      eventKey: `failed:${ctx.session.turn.id}`,
      occurredAt: occurredAt(event),
      turnId: ctx.session.turn.id,
      state: "failed",
    });
  },
};

export default defineHook({ events });
