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
        checkpointId: null,
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
    expect(JSON.stringify(call.prompt[0])).toContain("save before treating your");
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
    stalledForTurns: null,
    repeatingForTurns: null,
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

  it("states that an undecoded screen is normal and what still runs", () => {
    const rendered = renderView(screen("unknown", false));
    expect(rendered).toContain("Nothing on this screen decodes");
    expect(rendered).toContain("not a fault");
    expect(rendered).toContain("button_press and frame_advance");
    expect(rendered).toContain("use A only");
    expect(rendered).toContain("START, L, and R can open HELP");
  });

  it("names a screen that decodes but carries no position", () => {
    const rendered = renderView(screen("cutscene", false));
    expect(rendered).toContain("This is a cutscene screen");
    expect(rendered).toContain("expected, not a fault");
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
