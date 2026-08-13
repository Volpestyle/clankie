import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCaptainSessionLedger, type CaptainSessionLedger } from "../lib/session/ledger.ts";

// eve 0.22.4 hands un-timestamped events to stream-event hooks, so the hook's
// ledger dependency is exercised through a temp ledger holder rather than the
// captain's real project database.
const { ledgerHolder } = vi.hoisted(() => ({
  ledgerHolder: { current: undefined as CaptainSessionLedger | undefined },
}));
vi.mock("../lib/session/runtime.ts", () => ({
  captainSessionLedger: () => Promise.resolve(ledgerHolder.current),
}));

const { events, occurredAt } = await import("../agent/hooks/session-accounting.ts");

const roots: string[] = [];
const PROJECT_ID = "a".repeat(40);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

afterEach(async () => {
  vi.useRealTimers();
  ledgerHolder.current?.close();
  ledgerHolder.current = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("occurredAt durable timing derivation", () => {
  it("prefers the durable stream timestamp when a dispatch path supplies meta.at", () => {
    expect(occurredAt({ meta: { at: "2026-07-11T12:00:00.000Z" } }, () => "unused")).toBe(
      "2026-07-11T12:00:00.000Z",
    );
  });

  it("derives a dispatch-time timestamp for eve 0.22.4 un-timestamped stream events (no throw)", () => {
    // The previous implementation threw here. It must now derive durable timing.
    expect(() => occurredAt({})).not.toThrow();
    expect(occurredAt({}, () => "2026-07-11T09:09:09.000Z")).toBe("2026-07-11T09:09:09.000Z");
    expect(occurredAt({ meta: undefined }, () => "2026-07-11T09:09:09.000Z")).toBe(
      "2026-07-11T09:09:09.000Z",
    );
    expect(occurredAt({ meta: { at: undefined } }, () => "2026-07-11T09:09:09.000Z")).toBe(
      "2026-07-11T09:09:09.000Z",
    );
    // An empty string is not durable timing; fall back rather than record it.
    expect(occurredAt({ meta: { at: "" } }, () => "2026-07-11T09:09:09.000Z")).toBe(
      "2026-07-11T09:09:09.000Z",
    );
  });

  it("defaults to a real ISO-8601 wall-clock capture", () => {
    expect(occurredAt({})).toMatch(ISO);
  });
});

describe("session-accounting hook against un-timestamped stream events", () => {
  it("records durable session.started timing instead of fatal-failing the turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "captain-accounting-hook-"));
    roots.push(root);
    ledgerHolder.current = await openCaptainSessionLedger(PROJECT_ID, join(root, "captain.sqlite"));

    const startedHandler = events["session.started"];
    if (startedHandler === undefined) throw new Error("session.started handler missing");
    type StartedEvent = Parameters<typeof startedHandler>[0];
    type Ctx = Parameters<typeof startedHandler>[1];
    // eve 0.22.4 delivers the event with no meta.at to stream-event hooks.
    const event = { type: "session.started" } as unknown as StartedEvent;
    const ctx = { session: { id: "session-1", turn: { id: "turn-1" } } } as unknown as Ctx;

    await expect(startedHandler(event, ctx)).resolves.toBeUndefined();

    const snapshot = await ledgerHolder.current.snapshot("session-1");
    expect(snapshot).toMatchObject({ sessionId: "session-1", state: "active", lastTurnId: "turn-1" });
    expect(snapshot?.updatedAt).toMatch(ISO);
    expect(await ledgerHolder.current.verify()).toEqual({ valid: true, count: 1 });
  });

  it("deduplicates a replayed un-timestamped event after the wall clock advances", async () => {
    const root = await mkdtemp(join(tmpdir(), "captain-accounting-replay-"));
    roots.push(root);
    ledgerHolder.current = await openCaptainSessionLedger(PROJECT_ID, join(root, "captain.sqlite"));

    const startedHandler = events["session.started"];
    if (startedHandler === undefined) throw new Error("session.started handler missing");
    type StartedEvent = Parameters<typeof startedHandler>[0];
    type Ctx = Parameters<typeof startedHandler>[1];
    const event = { type: "session.started" } as unknown as StartedEvent;
    const ctx = { session: { id: "session-replay", turn: { id: "turn-1" } } } as unknown as Ctx;

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T09:09:09.000Z"));
    await startedHandler(event, ctx);
    vi.setSystemTime(new Date("2026-07-11T09:10:09.000Z"));
    await expect(startedHandler(event, ctx)).resolves.toBeUndefined();

    expect((await ledgerHolder.current.snapshot("session-replay"))?.updatedAt).toBe(
      "2026-07-11T09:09:09.000Z",
    );
    expect(await ledgerHolder.current.verify()).toEqual({ valid: true, count: 1 });
  });
});
