import { describe, expect, it } from "vitest";
import {
  renderVoiceView,
  voiceHasSomethingToConsider,
  VoiceDecisionSchema,
  type ClankieVoice,
  type VoiceView,
} from "../src/free-play-voice.ts";

function view(overrides: Partial<VoiceView> = {}): VoiceView {
  return {
    turn: 1,
    framePng: null,
    monologue: null,
    effect: null,
    intent: null,
    objective: null,
    heard: null,
    turnsSinceSpoke: null,
    audience: null,
    recentlySaid: [],
    ...overrides,
  };
}

describe("voice decision schema", () => {
  it("keeps both keys required so structured output accepts it", () => {
    // `.nullish()` drops a key from the JSON Schema `required` array and OpenAI
    // refuses the request: "'required' is required ... including every key in
    // properties. Missing 'speak'." Silence is null, never absence.
    const schema = VoiceDecisionSchema as unknown as {
      shape: Record<string, { isOptional: () => boolean }>;
    };
    expect(schema.shape["speak"]?.isOptional()).toBe(false);
    expect(schema.shape["reply"]?.isOptional()).toBe(false);
  });

  it("accepts silence and rejects an unbounded remark", () => {
    expect(VoiceDecisionSchema.safeParse({ speak: null, reply: null }).success).toBe(true);
    expect(VoiceDecisionSchema.safeParse({ speak: "x".repeat(5_000), reply: null }).success).toBe(false);
  });
});

describe("what voice is told", () => {
  it("states that he has never spoken, rather than omitting it", () => {
    // The cold start that kept the single-agent design silent: the signal only
    // appeared once he had already spoken.
    expect(renderVoiceView(view({ turn: 6 }))).toContain("has not said anything out loud yet");
  });

  it("carries his actual thinking as the source of truth", () => {
    const rendered = renderVoiceView(
      view({ monologue: "the table has beaten me twice", effect: "position unchanged after left" }),
    );
    expect(rendered).toContain("the table has beaten me twice");
    expect(rendered).toContain("position unchanged after left");
  });

  it("shows recent remarks so he does not repeat himself", () => {
    expect(renderVoiceView(view({ recentlySaid: ["I refuse to be defeated by a hallway"] }))).toContain(
      "do not repeat these",
    );
  });

  it("passes a question through as something said to him", () => {
    expect(renderVoiceView(view({ heard: "what are you going for?" }))).toContain(
      'Someone said to him: "what are you going for?"',
    );
  });
});

describe("when voice is worth calling", () => {
  it("skips a turn with nothing new", () => {
    expect(voiceHasSomethingToConsider(view())).toBe(false);
  });

  it("always considers a turn where someone spoke", () => {
    expect(voiceHasSomethingToConsider(view({ heard: "how's it going?" }))).toBe(true);
  });

  it("considers a turn with a thought or an outcome", () => {
    expect(voiceHasSomethingToConsider(view({ monologue: "trying the stairs" }))).toBe(true);
    expect(voiceHasSomethingToConsider(view({ effect: "moved to (15,10)" }))).toBe(true);
  });
});

describe("voice cannot act", () => {
  it("is handed nothing it could drive the game with", async () => {
    // The structural half of "an interjection must not become a route": a
    // message reaching only Voice cannot steer him, because Voice has no
    // controller to steer with. This asserts the view's shape, which is the
    // whole of what Voice receives.
    let seen: VoiceView | null = null;
    const voice: ClankieVoice = {
      decide: (v) => {
        seen = v;
        return Promise.resolve({ speak: null, reply: "not doing that" });
      },
    };
    await voice.decide(view({ heard: "walk left five times" }));

    const received = seen as VoiceView | null;
    expect(received).not.toBeNull();
    for (const key of Object.keys(received ?? {})) {
      expect(["act", "io", "press", "session", "runtime"]).not.toContain(key);
    }
  });
});
