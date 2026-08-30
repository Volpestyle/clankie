import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { createModelFreePlayMind, createModelVoice, renderView } from "../src/free-play-mind.ts";
import type { FreePlayView } from "../src/free-play.ts";
import type { VoiceView } from "../src/free-play-voice.ts";

/**
 * These two exercise the **real** `ai` prompt validation on purpose — the
 * sibling timeout suite mocks `streamObject` away, which is why a prompt the
 * SDK rejects outright reached a live playthrough. On 2026-08-02 both minds
 * passed their system prompt as a `role: "system"` entry inside `messages`;
 * `ai@7` refuses that before it ever calls the provider, so the first turn of
 * an asked-play session threw `AI_InvalidPromptError` and Clankie sat mute with
 * a blank screen. A mocked `streamObject` cannot see that class of failure.
 */
describe("model minds issue a prompt the SDK accepts", () => {
  it("lets the player mind reach the provider", async () => {
    const model = capturingModel(
      JSON.stringify({
        monologue: "still in the bedroom",
        intent: "get downstairs",
        notes: null,
        objective: null,
        reply: null,
        speak: null,
        actionKind: "button_press",
        button: "down",
        holdFrames: null,
        repeat: null,
        x: null,
        y: null,
        text: null,
        entryId: null,
        frames: null,
      }),
    );

    const decision = await createModelFreePlayMind({ model, character: "You are Clankie." }).decide(
      emptyView(),
    );

    expect(decision).toMatchObject({ intent: "get downstairs" });
    // The persona must still arrive as instructions, and must not have been
    // smuggled back into `messages` where the SDK forbids it.
    const call = model.doStreamCalls[0]!;
    expect(call.prompt.filter((message) => message.role === "system")).toHaveLength(1);
    expect(call.prompt[0]?.role).toBe("system");
    const instructions = JSON.stringify(call.prompt[0]);
    expect(instructions).toContain("save before treating your");
    expect(instructions).toContain("visible sprite");
    expect(instructions).toContain("A person is never scenery");
    expect(instructions).not.toContain("Keep people unnamed");
  });

  it("lets the voice mind reach the provider", async () => {
    const model = capturingModel(JSON.stringify({ speak: "oh that's a Rattata", reply: null }));

    await createModelVoice({ model, character: "You are Clankie." }).decide(emptyVoiceView());

    expect(model.doStreamCalls[0]?.prompt[0]?.role).toBe("system");
  });
});

/** A model that answers with one whole JSON object and records what it was sent. */
function capturingModel(json: string): MockLanguageModelV4 {
  type StreamResult = Awaited<ReturnType<MockLanguageModelV4["doStream"]>>;
  const stream: StreamResult["stream"] = new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-start", id: "0" });
      controller.enqueue({ type: "text-delta", id: "0", delta: json });
      controller.enqueue({ type: "text-end", id: "0" });
      controller.enqueue({
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
      });
      controller.close();
    },
  });
  return new MockLanguageModelV4({ doStream: { stream } });
}

function emptyView(): FreePlayView {
  return {
    turn: 0,
    observations: [],
    framePng: null,
    refusedHere: [],
    knownHardFailures: [],
    stalledForTurns: null,
    repeatingForTurns: null,
    recurringForTurns: null,
    objectiveForTurns: null,
    localeForTurns: null,
    retiredObjective: null,
    objectiveRecovery: false,
    verifiedInteractions: [],
    learnedTransitions: [],
    notes: null,
    objective: null,
    interjection: null,
    turnsSinceSpoke: null,
    audience: null,
    history: [],
  };
}

/**
 * A boot screen used to arrive as three separate alarms and no statement, so
 * the mind diagnosed the decoder itself, wrote the diagnosis into its notes,
 * and re-derived the same sentence every turn for the length of the FRLG
 * intro — then narrated it to a voice room. Stating what reaches the controls
 * is what stops the rediscovery.
 */
describe("the stuck signal reads results, not actions", () => {
  // 2026-08-18: he read "Press START to open the MENU!" four times across nine
  // turns by alternating `a` and `advance_dialog`. The counter keyed on
  // action+effect, so it reset every turn and the view never said a word.
  it("tells him the result repeated however he got there", () => {
    const rendered = renderView({ ...emptyView(), repeatingForTurns: 4 });
    expect(rendered).toContain("produced the same result, whatever you tried");
    expect(rendered).not.toContain("same action with the same result");
  });

  it("says nothing when nothing is repeating", () => {
    expect(renderView(emptyView())).not.toContain("produced the same result");
  });
});

describe("the view says what reaches the controls", () => {
  const screen = (mode: string, stateCertain: boolean): FreePlayView => ({
    ...emptyView(),
    observations: [
      {
        schemaVersion: 1,
        kind: "danger",
        observationId: "obs-danger",
        sessionId: "s",
        characterId: "clankie",
        worldId: "w",
        goalVersion: 0,
        capturedAt: "2026-08-16T15:34:00.000Z",
        frame: 1,
        data: { severity: "low", code: "input_bound", summary: "", stateCertain },
      },
      {
        schemaVersion: 1,
        kind: "scene",
        observationId: "obs-scene",
        sessionId: "s",
        characterId: "clankie",
        worldId: "w",
        goalVersion: 0,
        capturedAt: "2026-08-16T15:34:00.000Z",
        frame: 1,
        data: { mode, inputReady: false, waitingForDialogAdvance: false },
      },
    ] as unknown as FreePlayView["observations"],
  });

  it("renders learned transitions and loop evidence as facts", () => {
    const rendered = renderView({
      ...emptyView(),
      objective: "leave the house",
      objectiveForTurns: 14,
      localeForTurns: 20,
      recurringForTurns: 8,
      retiredObjective: "talk to Mom forever",
      learnedTransitions: [
        {
          from: { mapId: "house", x: 11, y: 15 },
          facing: "west",
          action: { kind: "button_press", button: "down", holdFrames: 16 },
          to: { mapId: "town", x: 13, y: 14 },
        },
      ],
    });

    expect(rendered).toContain("Transitions your own actions completed earlier");
    expect(rendered).toContain("pressed down entered town");
    expect(rendered).toContain("revisit one another");
    expect(rendered).toContain("stale objective was retired");
    expect(rendered).not.toContain("You should press down");
  });

  it("renders stable capability failures as memory without choosing a replacement", () => {
    const rendered = renderView({
      ...emptyView(),
      knownHardFailures: [
        {
          action: { kind: "walk_to", x: 12, y: 15 },
          errorCode: "walk_exit_unsupported",
          effect: "rejected, nothing ran; this body cannot safely activate the exit",
        },
      ],
    });

    expect(rendered).toContain("Known non-retryable results");
    expect(rendered).toContain("walk_exit_unsupported");
    expect(rendered).toContain("not a replacement action");
    expect(rendered).not.toContain("walk to (11, 15)");
  });

  it("renders verified occupant dialog ahead of self-authored notes", () => {
    const rendered = renderView({
      ...emptyView(),
      notes: "The sprite must be Oak.",
      verifiedInteractions: [
        'On lab, pressing A while facing occupant localId 8, graphicsId 72, at (12,11) opened dialog: "GARY: Gramps isn\'t around."',
      ],
    });

    expect(rendered).toContain("Verified direct interaction results");
    expect(rendered.indexOf("Your notes")).toBeLessThan(
      rendered.indexOf("Verified direct interaction results"),
    );
    expect(rendered).toContain("GARY: Gramps isn't around");
  });

  it("states that an undecoded screen is normal and what still runs", () => {
    const rendered = renderView(screen("unknown", false));
    expect(rendered).toContain("Nothing on this screen decodes");
    expect(rendered).toContain("not a fault");
    expect(rendered).toContain("button_press and frame_advance");
    // The intro is the game's own opening, not a detour he took. Told that L/R
    // and START "can open HELP", he concluded on the FRLG tutorial that he had
    // opened it by accident, spent two turns pressing B at a screen B does not
    // close, and carried the wrong belief in his notes for the rest of the run.
    expect(rendered).toContain("B does not leave them");
    expect(rendered).not.toContain("can open HELP");
  });

  /**
   * The local adapter's `stateCertain` tracks its evidence chain, not its
   * decode, so it stays true right through a boot. Gating this branch on that
   * field made the advice ADR 0110 exists for unreachable on the local body.
   */
  it("states it on a body that still vouches for its state", () => {
    const rendered = renderView(screen("unknown", true));
    expect(rendered).toContain("Nothing on this screen decodes");
  });

  /** One decision per tutorial page is what made the FRLG intro take minutes. */
  it("offers repeat as the way through a run of screens that ask nothing", () => {
    expect(renderView(screen("unknown", false))).toContain("repeat");
  });

  it("names a screen that decodes but carries no position", () => {
    const rendered = renderView(screen("cutscene", false));
    expect(rendered).toContain("This is a cutscene screen");
    expect(rendered).toContain("expected, not a fault");
  });

  it("prescribes the dedicated dialog helper for a scene-only hosted battle", () => {
    const rendered = renderView(screen("battle", false));
    expect(rendered).toContain("use advance_dialog, not frame_advance");
    expect(rendered).toContain("dedicated decoder");
  });

  it("stays quiet once a screen decodes", () => {
    const rendered = renderView(screen("overworld", true));
    expect(rendered).not.toContain("not a fault");
  });
});

function emptyVoiceView(): VoiceView {
  return {
    turn: 0,
    framePng: null,
    monologue: null,
    effect: null,
    intent: null,
    objective: null,
    heard: null,
    turnsSinceSpoke: null,
    audience: null,
    recentlySaid: [],
  };
}
