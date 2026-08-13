import { defineHook } from "eve/hooks";
import { toolResultFrom } from "eve/tools";
import { captainPresenceReporter, logPresenceError } from "../../lib/presence/runtime.ts";
import getMission from "../tools/get_mission.ts";
import startMission from "../tools/start_mission.ts";

const presence = captainPresenceReporter();
if (presence !== undefined) void presence.start().catch(logPresenceError);

/**
 * Timestamp for one presence report from a hook-delivered stream event.
 *
 * Eve stamps `meta.at` at the persistence seam, after hooks fire, so a live
 * hook event legitimately carries no durable timing yet (`meta` is optional on
 * `HandleMessageStreamEvent`). Hook-fire wall clock is the same moment a few
 * milliseconds early, and the control plane deduplicates reports by eventId,
 * so a replayed event can never re-report with a fresher timestamp. Requiring
 * `meta.at` here silently killed every lifecycle report in production.
 */
export function occurredAt(event: { readonly meta?: { readonly at: string } }): string {
  return event.meta?.at ?? new Date().toISOString();
}

/**
 * Runs a presence report without ever letting it end the turn.
 *
 * `operation().catch(...)` looks like it does that and does not: a
 * *synchronous* throw while evaluating the thunk escapes before `.catch` is
 * ever attached. It then leaves the hook, eve retries the step three times,
 * and the session ends `failed` — a Discord message answered with silence
 * because telemetry could not be reported. Starting from a resolved promise
 * puts the thunk's own execution inside the chain, so sync and async failures
 * are both merely logged.
 */
function safely(operation: (() => Promise<void>) | undefined): Promise<void> {
  if (operation === undefined) return Promise.resolve();
  return Promise.resolve().then(operation).catch(logPresenceError);
}

function missionIdentity(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const candidate = record.missionId ?? record.id;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function missionTerminal(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const state = (value as Record<string, unknown>).state;
  return ["succeeded", "failed", "completed", "cancelled"].includes(String(state));
}

export default defineHook({
  events: {
    "session.started": () => safely(presence === undefined ? undefined : () => presence.start()),
    "turn.started": (event, ctx) =>
      safely(
        presence === undefined
          ? undefined
          : () =>
              presence.turnStarted({
                sessionId: ctx.session.id,
                turnId: event.data.turnId,
                eventId: `turn-started:${event.data.turnId}`,
                occurredAt: occurredAt(event),
              }),
      ),
    "input.requested": (event, ctx) =>
      safely(
        presence === undefined
          ? undefined
          : () =>
              presence.waitingUser({
                sessionId: ctx.session.id,
                turnId: event.data.turnId,
                eventId: `input-requested:${event.data.turnId}:${String(event.data.sequence)}`,
                occurredAt: occurredAt(event),
                requests: event.data.requests.map((request) => ({
                  callId: request.action.callId,
                  summary:
                    request.display === "confirmation"
                      ? `Captain requested approval for ${request.action.toolName}`
                      : "Captain asked for operator input",
                })),
              }),
      ),
    "action.result": async (event, ctx) => {
      if (presence === undefined) return;
      const started = toolResultFrom(event.data.result, startMission);
      if (started !== undefined) {
        const missionId = missionIdentity(started.output) ?? event.data.result.callId;
        presence.noteDependency(ctx.session.id, `mission:${missionId}`, "Waiting for mission workers");
      }
      const mission = toolResultFrom(event.data.result, getMission);
      if (mission !== undefined && missionTerminal(mission.output)) {
        const missionId = missionIdentity(mission.output);
        if (missionId !== undefined) presence.resolveDependency(ctx.session.id, `mission:${missionId}`);
      }
      await safely(() =>
        presence.inputResolved({
          sessionId: ctx.session.id,
          turnId: event.data.turnId,
          eventId: `input-resolved:${event.data.turnId}:${event.data.result.callId}:${String(event.data.sequence)}`,
          occurredAt: occurredAt(event),
          callId: event.data.result.callId,
        }),
      );
    },
    "subagent.called": (event, ctx) => {
      presence?.noteDependency(
        ctx.session.id,
        `subagent:${event.data.callId}`,
        `Waiting for ${event.data.name}`,
      );
    },
    "subagent.completed": (event, ctx) => {
      presence?.resolveDependency(ctx.session.id, `subagent:${event.data.callId}`);
    },
    "session.waiting": (event, ctx) =>
      safely(
        presence === undefined
          ? undefined
          : () =>
              presence.sessionWaiting({
                sessionId: ctx.session.id,
                turnId: ctx.session.turn.id,
                eventId: `session-waiting:${ctx.session.turn.id}`,
                occurredAt: occurredAt(event),
              }),
      ),
    "session.completed": (event, ctx) =>
      safely(
        presence === undefined
          ? undefined
          : () =>
              presence.sessionSettled({
                sessionId: ctx.session.id,
                turnId: ctx.session.turn.id,
                eventId: `session-completed:${ctx.session.turn.id}`,
                occurredAt: occurredAt(event),
              }),
      ),
    "session.failed": (event, ctx) =>
      safely(
        presence === undefined
          ? undefined
          : () =>
              presence.sessionSettled({
                sessionId: ctx.session.id,
                turnId: ctx.session.turn.id,
                eventId: `session-failed:${ctx.session.turn.id}`,
                occurredAt: occurredAt(event),
              }),
      ),
  },
});
