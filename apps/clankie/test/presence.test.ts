import { createOperatorConversationServiceClient } from "../../../packages/protocol/src/index.ts";
import { describe, expect, it, vi } from "vitest";
import { pollPresence, projectPresence, captainIsThinking } from "../src/captain/presence.ts";
import {
  OperatorPresenceRequestSchema,
  OperatorPresenceSnapshotSchema,
} from "../../../packages/protocol/src/presence.ts";
import { hostedOperatorAllows } from "../../../packages/protocol/src/hosted-operator.ts";

const idle = { thinking: false, inVoice: false, playing: false, activeSeats: 0 };
describe("present tense", () => {
  it("projects bounded concurrent public activities only for opted-in readers", () => {
    const sources = {
      ...idle,
      thinking: true,
      inVoice: true,
      playing: true,
      activeSeats: 4,
      voiceSince: "2026-10-06T20:00:00.000Z",
    };
    const old = projectPresence(sources, false);
    expect(old).not.toHaveProperty("activities");
    const snapshot = OperatorPresenceSnapshotSchema.parse(projectPresence(sources, false, false, true));
    expect(snapshot.activities).toEqual([
      { kind: "working", label: "Working", since: null },
      { kind: "voice", label: "In a voice chat", since: sources.voiceSince },
      { kind: "playing", label: "Playing", since: null },
    ]);
    expect(projectPresence(sources, false, false, true).cursor).toBe(snapshot.cursor);
    expect(projectPresence({ ...idle, activeSeats: 4 }, false, false, true).activities).toEqual([
      { kind: "leading", label: "Leading 4 workers", since: null },
    ]);
    expect(projectPresence({ ...idle, working: true }, true, false, true)).toMatchObject({
      mood: "thinking",
      activities: [{ kind: "working", label: "Working", since: null }],
    });
    expect(projectPresence(idle, false, false, true).activities).toEqual([]);
  });
  it("reads active captain lanes, including background Discord turns, without waiting for model construction", async () => {
    const operator = Promise.resolve({ session: { isStreaming: false } });
    const discord = Promise.resolve({ running: Promise.resolve(true), session: { isStreaming: false } });
    expect(await captainIsThinking([operator, discord])).toBe(true);
    expect(await captainIsThinking([operator, new Promise(() => {})])).toBe(false);
    expect(
      await captainIsThinking([
        Promise.resolve({ starting: Promise.resolve(), session: { isStreaming: false } }),
      ]),
    ).toBe(true);
    expect(await captainIsThinking([Promise.resolve({ session: { isStreaming: true } })])).toBe(true);
  });
  it("exposes the shared client's cursor, bounded wait and cancellation seam", async () => {
    const snapshot = projectPresence(idle);
    const dispatch = vi.fn(async () => ({ op: "presence" as const, schemaVersion: 1 as const, snapshot }));
    const client = createOperatorConversationServiceClient(dispatch, { fleetWaitMs: 30001 });
    const signal = new AbortController().signal;
    expect(await client.presence!("previous", signal)).toEqual(snapshot);
    expect(dispatch).toHaveBeenCalledWith(
      { op: "presence", schemaVersion: 1, cursor: "previous", waitMs: 30000 },
      signal,
    );
  });
  it("projects precedence and counts waiting live seats", () => {
    const sources = { ...idle, thinking: true, inVoice: true, playing: true, activeSeats: 3 };
    expect(projectPresence(sources).mood).toBe("thinking");
    expect(projectPresence({ ...sources, thinking: false }).mood).toBe("in_voice");
    expect(projectPresence({ ...sources, thinking: false, inVoice: false }).mood).toBe("playing");
    expect(projectPresence({ ...idle, activeSeats: 3 })).toMatchObject({
      mood: "leading",
      activeSeats: 3,
      since: null,
    });
    expect(projectPresence(idle).mood).toBe("idle");
    const pendingOwnerItem = {
      conversationId: "chat",
      questionId: "00000000-0000-4000-8000-000000000000",
      title: "Choose a color",
      since: "2026-10-04T10:00:00.000Z",
    };
    expect(projectPresence({ ...sources, pendingOwnerItem })).toMatchObject({
      mood: "needs_you",
      pendingOwnerItem,
      since: pendingOwnerItem.since,
    });
  });
  it("keeps a quiet cursor stable and changes it for owner items or live seats", () => {
    expect(projectPresence(idle).cursor).toBe(projectPresence(idle).cursor);
    expect(projectPresence({ ...idle, activeSeats: 1 }).cursor).not.toBe(projectPresence(idle).cursor);
    expect(OperatorPresenceSnapshotSchema.safeParse(projectPresence(idle)).success).toBe(true);
  });
  it("enforces strict requests and the long-poll ceiling", () => {
    expect(
      OperatorPresenceRequestSchema.safeParse({ op: "presence", schemaVersion: 1, waitMs: 30001 }).success,
    ).toBe(false);
    expect(
      OperatorPresenceRequestSchema.safeParse({ op: "presence", schemaVersion: 1, extra: true }).success,
    ).toBe(false);
    expect(
      hostedOperatorAllows(
        "POST",
        "/operator/v1/dispatch",
        JSON.stringify({ op: "presence", schemaVersion: 1 }),
      ),
    ).toBe(true);
  });
  it("returns immediately for an old cursor and wakes when a source changes", async () => {
    const first = projectPresence(idle);
    expect(await pollPresence(async () => first, "old", 30000)).toEqual(first);
    let reads = 0;
    const changed = projectPresence({ ...idle, thinking: true });
    expect(await pollPresence(async () => (++reads === 1 ? first : changed), first.cursor, 1000)).toEqual(
      changed,
    );
    expect(await pollPresence(async () => first, first.cursor, 0)).toEqual(first);
  });
  it("cancels a parked read on service shutdown", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      pollPresence(async () => projectPresence(idle), undefined, 1000, abort.signal),
    ).rejects.toThrow();
  });
});
