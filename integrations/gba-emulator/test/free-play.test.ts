import type { EnvironmentActionResult, GbaEmulatorObservation } from "@clankie/interactive-environment";
import { describe, expect, it, vi } from "vitest";
import type { GbaDriverIo } from "../src/driver.ts";
import {
  FREE_PLAY_INTERJECTION_MAX,
  FREE_PLAY_MONOLOGUE_MAX,
  FREE_PLAY_NOTES_MAX,
  FREE_PLAY_REPLY_MAX,
  InterjectionQueue,
  intentMatchesAction,
  runFreePlay,
  type FreePlayMind,
} from "../src/free-play.ts";

function overworld(frame: number, x = 5): GbaEmulatorObservation {
  return {
    schemaVersion: 1,
    kind: "overworld",
    observationId: `obs-${String(frame)}`,
    sessionId: "gba-emulator:test",
    characterId: "clankie",
    worldId: "gba-emulator-lab-v1",
    goalVersion: 0,
    capturedAt: "2026-07-25T18:00:00.000Z",
    frame,
    data: {
      position: { mapId: "PALLET_TOWN", x, y: 6 },
      facing: "south",
      ramStateSha256: "b".repeat(64),
    },
  } as unknown as GbaEmulatorObservation;
}

function completed(): EnvironmentActionResult {
  return {
    schemaVersion: 1,
    status: "completed",
    actionId: "11111111-1111-4111-8111-111111111111",
    sessionId: "gba-emulator:test",
    updatedAt: "2026-07-25T18:00:00.000Z",
    acceptedGoalVersion: 0,
    outcome: { applied: true },
  } as EnvironmentActionResult;
}

function failed(errorCode: string): EnvironmentActionResult {
  return {
    schemaVersion: 1,
    status: "failed",
    actionId: "22222222-2222-4222-8222-222222222222",
    sessionId: "gba-emulator:test",
    updatedAt: "2026-07-25T18:00:00.000Z",
    acceptedGoalVersion: 0,
    errorCode,
    message: "input bound exceeded",
    retryable: false,
  } as EnvironmentActionResult;
}

function io(act: () => Promise<EnvironmentActionResult>): GbaDriverIo {
  let frame = 100;
  let x = 5;
  return {
    observe: (kind) => {
      // Only the overworld view exists here; other kinds throw exactly as the
      // adapter does when a view is meaningless in the current state.
      if (kind !== "overworld") throw new Error(`no ${kind} view`);
      frame += 1;
      // Position advances, so actions read as real moves and plans survive.
      x += 1;
      return overworld(frame, x);
    },
    act,
    pause: () => Promise.resolve(),
  };
}

function mind(decisions: unknown[]): FreePlayMind {
  let index = 0;
  return {
    decide: () => {
      const next = decisions[Math.min(index, decisions.length - 1)];
      index += 1;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };
}

const press = (button: string, intent: string, notes: string | null = null) => ({
  monologue: `I want to head ${intent}.`,
  intent: `move ${intent}`,
  notes,
  action: { kind: "button_press", button, holdFrames: 4 },
});

describe("free play", () => {
  it("lets the model choose and records a causally linked trace", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([press("up", "up"), press("left", "left")]),
      turns: 2,
      framebufferSha256: () => "a".repeat(64),
    });

    expect(result.accepted).toBe(2);
    expect(result.turns).toHaveLength(2);
    const [first] = result.turns;
    expect(first?.outcome).toBe("accepted");
    expect(first?.action).toMatchObject({ kind: "button_press", button: "up" });
    expect(first?.monologue).toContain("head up");
    // Digests link the decision to the state it was made from.
    expect(first?.observationSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(first?.framebufferSha256).toBe("a".repeat(64));
    // The trace carries digests, never frame bytes.
    expect(JSON.stringify(result.turns)).not.toContain("data:image");
  });

  it("survives an adapter rejection and keeps playing", async () => {
    const act = vi
      .fn<() => Promise<EnvironmentActionResult>>()
      .mockResolvedValueOnce(failed("frame_bound_exceeded"))
      .mockResolvedValue(completed());

    const result = await runFreePlay({
      io: io(act),
      mind: mind([press("up", "up"), press("down", "down")]),
      turns: 2,
    });

    // A rejection is a legitimate answer, not a crash: the loop continues.
    expect(result.turns[0]?.outcome).toBe("rejected_by_adapter");
    expect(result.turns[0]?.detail).toContain("frame_bound_exceeded");
    expect(result.turns[1]?.outcome).toBe("accepted");
    expect(result.accepted).toBe(1);
  });

  it("survives an unparseable decision and a model that throws", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([{ monologue: "no action field" }, new Error("model unavailable"), press("a", "a")]),
      turns: 3,
    });

    expect(result.turns[0]?.outcome).toBe("invalid_decision");
    expect(result.turns[1]?.outcome).toBe("mind_failed");
    expect(result.turns[1]?.detail).toContain("model unavailable");
    // Neither failure ends the playthrough.
    expect(result.turns[2]?.outcome).toBe("accepted");
  });

  it("rejects an out-of-bounds action and unbounded model text", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([
        // Not a catalogued button.
        {
          monologue: "mash it",
          intent: "mash",
          action: { kind: "button_press", button: "turbo", holdFrames: 4 },
        },
        {
          monologue: "x".repeat(FREE_PLAY_MONOLOGUE_MAX + 1),
          intent: "ramble",
          action: { kind: "frame_advance", frames: 4 },
        },
      ]),
      turns: 2,
    });

    expect(result.turns[0]?.outcome).toBe("invalid_decision");
    // Untrusted model text is bounded before it can reach an operator surface.
    expect(result.turns[1]?.outcome).toBe("invalid_decision");
    expect(result.accepted).toBe(0);
  });

  it("does not count a revised plan as incoherence when the world refused him", async () => {
    // Blocked, then he changes direction. Revising is the correct response, so
    // the transition is excluded rather than scored as a broken promise.
    const blockingIo: GbaDriverIo = {
      observe: (kind) => {
        if (kind !== "overworld") throw new Error(`no ${kind} view`);
        return overworld(100);
      },
      act: () => Promise.resolve(completed()),
      pause: () => Promise.resolve(),
    };
    const result = await runFreePlay({
      io: blockingIo,
      mind: mind([
        {
          monologue: "west",
          intent: "go left",
          action: { kind: "button_press", button: "left", holdFrames: 4 },
        },
        {
          monologue: "that wall again",
          intent: "try up instead",
          action: { kind: "button_press", button: "up", holdFrames: 4 },
        },
      ]),
      turns: 2,
    });
    // The position never changes, so every turn is a refusal: nothing scoreable.
    expect(result.turns[0]?.effect).toContain("position unchanged");
    expect(result.coherence).toBeNull();
  });

  it("scores coherence as a reported lower bound, never a gate", async () => {
    const result = await runFreePlay({
      // This io advances position every observation, so plans survive and the
      // transitions are scoreable.
      io: io(() => Promise.resolve(completed())),
      mind: mind([
        {
          monologue: "north first",
          intent: "go up the path",
          action: { kind: "button_press", button: "up", holdFrames: 4 },
        },
        // Follows through on "up".
        {
          monologue: "still north",
          intent: "keep going up",
          action: { kind: "button_press", button: "up", holdFrames: 4 },
        },
        // Contradicts the stated intent.
        {
          monologue: "changed my mind",
          intent: "keep going up",
          action: { kind: "button_press", button: "left", holdFrames: 4 },
        },
      ]),
      turns: 3,
    });

    // Two scoreable transitions, one of which followed through.
    expect(result.coherence).toBeCloseTo(0.5, 5);
    // Nothing about a low score fails the run.
    expect(result.accepted).toBe(3);
  });

  it("matches intent to action by keyword, tolerating natural phrasing", () => {
    const up = { kind: "button_press", button: "up", holdFrames: 4 } as const;
    expect(intentMatchesAction("head north toward the lab", up)).toBe(true);
    expect(intentMatchesAction("walk up a bit", up)).toBe(true);
    expect(intentMatchesAction("open the bag", up)).toBe(false);
    expect(intentMatchesAction("let the dialog play out", { kind: "frame_advance", frames: 8 })).toBe(true);
  });

  it("reports no coherence when there is nothing to score", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([press("up", "up")]),
      turns: 1,
    });
    expect(result.coherence).toBeNull();
  });
});

describe("burst actions", () => {
  it("accepts a bounded repeat and reports it in the trace", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([
        {
          monologue: "long corridor",
          intent: "cross the corridor",
          action: { kind: "button_press", button: "left", holdFrames: 16, repeat: 5 },
        },
      ]),
      turns: 1,
    });
    expect(result.turns[0]?.outcome).toBe("accepted");
    expect(result.turns[0]?.action).toMatchObject({ button: "left", repeat: 5 });
  });

  it("rejects a repeat beyond the catalogued bound", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([
        {
          monologue: "mash",
          intent: "mash",
          // A burst is coarser granularity, not an unbounded budget.
          action: { kind: "button_press", button: "left", holdFrames: 4, repeat: 99 },
        },
      ]),
      turns: 1,
    });
    expect(result.turns[0]?.outcome).toBe("invalid_decision");
  });

  it("treats an omitted repeat as a single press, so frozen actions are unchanged", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([press("up", "up")]),
      turns: 1,
    });
    expect(result.turns[0]?.action).toMatchObject({ kind: "button_press", button: "up" });
    const first = result.turns[0]?.action as { repeat?: number } | null | undefined;
    expect(first?.repeat).toBeUndefined();
  });
});

describe("persistent notes", () => {
  it("carries his notes forward and lets him rewrite them", async () => {
    const seen: (string | null)[] = [];
    const recordingMind: FreePlayMind = {
      decide: (view) => {
        seen.push(view.notes);
        const step = seen.length;
        return Promise.resolve(press("up", "up", step === 1 ? "stairs are upper-right" : null));
      },
    };
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: recordingMind,
      turns: 3,
    });

    // Nothing on the first turn, then his own note handed back verbatim.
    expect(seen[0]).toBeNull();
    expect(seen[1]).toBe("stairs are upper-right");
    // Returning null leaves them standing rather than erasing them.
    expect(seen[2]).toBe("stairs are upper-right");
    expect(result.turns.at(-1)?.notes).toBe("stairs are upper-right");
  });

  it("rejects notes beyond the bound instead of growing the prompt forever", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([press("up", "up", "x".repeat(FREE_PLAY_NOTES_MAX + 1))]),
      turns: 1,
    });
    expect(result.turns[0]?.outcome).toBe("invalid_decision");
  });
});

describe("interjection", () => {
  it("reaches the next turn and is answered without losing turn state", async () => {
    const seen: (string | null)[] = [];
    const queue = new InterjectionQueue();
    queue.offer("how's it going?");
    const listening: FreePlayMind = {
      decide: (view) => {
        seen.push(view.interjection);
        return Promise.resolve({
          ...press("up", "up"),
          reply: view.interjection === null ? null : "slow, this desk keeps blocking me",
        });
      },
    };
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: listening,
      turns: 2,
      interjections: queue,
    });

    expect(seen[0]).toBe("how's it going?");
    // Consumed once: a question is not re-asked every turn afterwards.
    expect(seen[1]).toBeNull();
    expect(result.turns[0]?.reply).toContain("desk");
    expect(result.turns[1]?.reply).toBeNull();
    // Play continued either way.
    expect(result.accepted).toBe(2);
    // Recorded, so an interjection's influence stays auditable.
    expect(result.turns[0]?.interjection).toBe("how's it going?");
  });

  it("keeps only the newest message rather than a stale backlog", () => {
    const queue = new InterjectionQueue();
    queue.offer("first");
    queue.offer("second");
    // Answering an old question several turns late reads worse than the newest.
    expect(queue.take()).toBe("second");
    expect(queue.take()).toBeNull();
  });

  it("ignores empty chatter and bounds what one person can say", () => {
    const queue = new InterjectionQueue();
    queue.offer("   ");
    expect(queue.take()).toBeNull();
    queue.offer("x".repeat(FREE_PLAY_INTERJECTION_MAX + 100));
    expect(queue.take()?.length).toBe(FREE_PLAY_INTERJECTION_MAX);
  });

  it("rejects a reply longer than a person could be sent", async () => {
    const result = await runFreePlay({
      io: io(() => Promise.resolve(completed())),
      mind: mind([{ ...press("up", "up"), reply: "x".repeat(FREE_PLAY_REPLY_MAX + 1) }]),
      turns: 1,
    });
    expect(result.turns[0]?.outcome).toBe("invalid_decision");
  });
});
