import { describe, expect, it } from "vitest";
import {
  DEFAULT_DECAY_WINDOW_MS,
  VOLITION_DEFAULTS,
  VoiceFloor,
  type VoiceFloorOptions,
  type VoiceTranscriptEvent,
} from "../src/voice-floor.ts";

const names = ["clankie", "clanky", "clank"];
const WINDOW = 60_000;

function floor(overrides: Partial<VoiceFloorOptions> = {}): VoiceFloor {
  return new VoiceFloor({
    names,
    replyPolicy: "addressed",
    chattiness: "balanced",
    decayWindowMs: WINDOW,
    ...overrides,
  });
}

function said(speakerId: string, text: string, atMs: number): VoiceTranscriptEvent {
  return { speakerId, text, atMs };
}

describe("waking", () => {
  it("wakes on being addressed, for free, and the speaker takes the floor", () => {
    const f = floor();
    expect(f.state).toBe("dormant");
    expect(f.floorHolderId).toBeUndefined();
    expect(f.observeTranscript(said("alice", "hey clankie you there", 0))).toEqual({
      action: "wake",
      reason: "addressed",
    });
    expect(f.state).toBe("engaged");
    expect(f.floorHolderId).toBe("alice");
  });

  it("wakes on a mis-transcribed name", () => {
    const f = floor();
    expect(f.observeTranscript(said("alice", "klanky what do you think", 0))).toEqual({
      action: "wake",
      reason: "addressed",
    });
  });

  it("under the all policy, any speech wakes him", () => {
    const f = floor({ replyPolicy: "all" });
    expect(f.observeTranscript(said("bob", "morning everyone", 0))).toEqual({
      action: "wake",
      reason: "reply_policy_all",
    });
    expect(f.floorHolderId).toBe("bob");
  });

  it("a closing phrase heard while dormant is still an address, so it wakes", () => {
    // Someone saying "thanks clankie" is a person speaking to him, whatever
    // else the sentence means, and a missed wake is the worse social failure.
    const f = floor();
    expect(f.observeTranscript(said("alice", "thanks clankie", 0))).toEqual({
      action: "wake",
      reason: "addressed",
    });
  });

  it("a transcript with no speech in it wakes nothing, even under all", () => {
    const f = floor({ replyPolicy: "all" });
    expect(f.observeTranscript(said("bob", "", 0))).toEqual({ action: "ignore" });
    expect(f.observeTranscript(said("bob", " ... ", 1_000))).toEqual({ action: "ignore" });
    expect(f.state).toBe("dormant");
  });
});

describe("holding the floor", () => {
  it("the floor holder continuing without naming him is an offer, and does not refresh decay", () => {
    const f = floor();
    f.observeTranscript(said("alice", "clankie run the tests", 0));
    expect(f.observeTranscript(said("alice", "actually just the voice ones", 8_000))).toEqual({
      action: "offer",
      reason: "holder",
    });
    expect(f.floorHolderId).toBe("alice");
    // Same-breath pivot is also an offer: the model may stay silent.
    expect(f.observeTranscript(said("alice", "yeah thanks. bob did you finish that thing", 9_000))).toEqual({
      action: "offer",
      reason: "holder",
    });
    expect(f.tick(WINDOW)).toEqual({ action: "ignore" });
    expect(f.tick(WINDOW + 1)).toEqual({ action: "release", reason: "decay" });
  });

  it("a name mention that is not a clean hail is an offer from anyone, including dormant", () => {
    const f = floor();
    expect(f.observeTranscript(said("bob", "clankie did you see that", 0))).toEqual({
      action: "offer",
      reason: "mentioned",
    });
    expect(f.state).toBe("dormant");
    expect(f.floorHolderId).toBeUndefined();
    expect(f.observeTranscript(said("alice", "clankie just tell me the score", 5_000))).toEqual({
      action: "offer",
      reason: "mentioned",
    });
    expect(f.floorHolderId).toBeUndefined();
    f.noteSpeechFrom("alice", 5_000);
    expect(f.floorHolderId).toBe("alice");
  });

  it("a mention does not steal the holder from a clean hail", () => {
    const f = floor();
    f.observeTranscript(said("alice", "hey clankie", 0));
    expect(f.observeTranscript(said("bob", "clankie did you see that", 5_000))).toEqual({
      action: "offer",
      reason: "mentioned",
    });
    expect(f.floorHolderId).toBe("alice");
    expect(f.observeTranscript(said("bob", "hey bob what did clankie say to you", 6_000))).toEqual({
      action: "listen",
    });
    expect(f.floorHolderId).toBe("alice");
  });

  it("clear third-party talk about him does not offer a turn", () => {
    const f = floor();
    f.observeTranscript(said("alice", "hey clankie", 0));
    expect(f.observeTranscript(said("bob", "ask clankie about it", 5_000))).toEqual({ action: "listen" });
    expect(f.observeTranscript(said("bob", "hey bob what did clankie say to you", 6_000))).toEqual({
      action: "listen",
    });
    expect(f.floorHolderId).toBe("alice");
  });

  it("a re-address from anyone holds and moves the floor to that speaker", () => {
    const f = floor();
    f.observeTranscript(said("alice", "hey clankie", 0));
    expect(f.observeTranscript(said("bob", "clanky what about you", 10_000))).toEqual({ action: "hold" });
    expect(f.floorHolderId).toBe("bob");
    // The previous holder is a bystander now; nameless speech from them is overheard.
    expect(f.observeTranscript(said("alice", "and then i told him", 20_000))).toEqual({
      action: "listen",
    });
  });

  it("crosstalk between other people is overheard and does not refresh decay", () => {
    const f = floor();
    f.observeTranscript(said("alice", "clankie you there", 0));
    expect(f.observeTranscript(said("bob", "so anyway the meeting moved", 30_000))).toEqual({
      action: "listen",
    });
    // Had the crosstalk refreshed the clock, this tick would still be inside the window.
    expect(f.tick(WINDOW + 1)).toEqual({ action: "release", reason: "decay" });
  });

  it("his own speech refreshes decay while he talks", () => {
    const f = floor();
    f.observeTranscript(said("alice", "clankie tell us a story", 0));
    f.noteAssistantSpokeAt(50_000);
    expect(f.tick(WINDOW + 1)).toEqual({ action: "ignore" });
    expect(f.tick(50_000 + WINDOW + 1)).toEqual({ action: "release", reason: "decay" });
  });

  it("an empty transcript from the holder does not refresh decay", () => {
    const f = floor();
    f.observeTranscript(said("alice", "clankie you there", 0));
    expect(f.observeTranscript(said("alice", "…", 50_000))).toEqual({ action: "ignore" });
    expect(f.tick(WINDOW + 1)).toEqual({ action: "release", reason: "decay" });
  });

  it("under the all policy, engaged crosstalk is still overheard", () => {
    const f = floor({ replyPolicy: "all" });
    f.observeTranscript(said("alice", "morning", 0));
    expect(f.observeTranscript(said("bob", "morning alice", 5_000))).toEqual({ action: "listen" });
    expect(f.floorHolderId).toBe("alice");
  });
});

describe("closing phrases", () => {
  it("a goodbye with his name in it is an address he gets to answer, not a cut-off", () => {
    // No phrase releases the floor. "thanks clankie" reaches him like any other
    // address, he replies to it, and the decay window ends the exchange.
    const f = floor();
    f.observeTranscript(said("alice", "hey clankie", 0));
    expect(f.observeTranscript(said("bob", "thanks clankie", 10_000))).toEqual({ action: "hold" });
    expect(f.state).toBe("engaged");
    expect(f.floorHolderId).toBe("bob");
    expect(f.tick(10_000 + WINDOW + 1)).toEqual({ action: "release", reason: "decay" });
  });

  it("thanks aimed at another person is still crosstalk", () => {
    const f = floor();
    f.observeTranscript(said("alice", "hey clankie", 0));
    expect(f.observeTranscript(said("bob", "thanks bob that fixed it", 10_000))).toEqual({
      action: "listen",
    });
    expect(f.state).toBe("engaged");
    expect(f.floorHolderId).toBe("alice");
  });

  it("the holder saying a nameless thanks keeps the floor rather than dropping it", () => {
    const f = floor();
    f.observeTranscript(said("alice", "hey clankie", 0));
    expect(f.observeTranscript(said("alice", "thanks anyway man", 10_000))).toEqual({
      action: "offer",
      reason: "holder",
    });
    expect(f.state).toBe("engaged");
  });
});

describe("decay", () => {
  it("releases on silence alone, with no phrase at all, under an explicit clock", () => {
    const f = floor();
    f.observeTranscript(said("alice", "clankie you around", 0));
    expect(f.tick(WINDOW)).toEqual({ action: "ignore" });
    expect(f.tick(WINDOW + 1)).toEqual({ action: "release", reason: "decay" });
    expect(f.state).toBe("dormant");
    expect(f.floorHolderId).toBeUndefined();
  });

  it("is also checked on transcript arrival, not only on tick", () => {
    const f = floor();
    f.observeTranscript(said("alice", "clankie you around", 0));
    expect(f.observeTranscript(said("bob", "unrelated chatter much later", WINDOW + 5_000))).toEqual({
      action: "release",
      reason: "decay",
    });
    expect(f.state).toBe("dormant");
  });

  it("an address arriving after the window is a fresh wake, never eaten by decay", () => {
    const f = floor();
    f.observeTranscript(said("alice", "clankie you around", 0));
    expect(f.observeTranscript(said("bob", "clankie what do you think", WINDOW * 3))).toEqual({
      action: "wake",
      reason: "addressed",
    });
    expect(f.state).toBe("engaged");
    expect(f.floorHolderId).toBe("bob");
  });

  it("ticking while dormant is a no-op", () => {
    const f = floor();
    expect(f.tick(10_000_000)).toEqual({ action: "ignore" });
    expect(f.accounting()).toEqual({ offered: 0, taken: 0, suppressed: 0 });
  });

  it("uses the documented default window when none is configured", () => {
    const f = new VoiceFloor({ names, replyPolicy: "addressed", chattiness: "balanced" });
    f.observeTranscript(said("alice", "hey clankie", 0));
    expect(f.tick(DEFAULT_DECAY_WINDOW_MS)).toEqual({ action: "ignore" });
    expect(f.tick(DEFAULT_DECAY_WINDOW_MS + 1)).toEqual({ action: "release", reason: "decay" });
  });
});

describe("volition gate", () => {
  const gated = () => floor({ volition: { minIntervalMs: 60_000, maxPerHour: 2 } });

  it("opens on unaddressed transcript when the cap permits, and counts the offer", () => {
    const f = gated();
    expect(f.observeTranscript(said("bob", "the build is red again", 0))).toEqual({
      action: "volition_gate_open",
    });
    expect(f.state).toBe("dormant");
    expect(f.accounting()).toEqual({ offered: 1, taken: 0, suppressed: 0 });
  });

  it("stays shut inside the minimum interval since the last offer", () => {
    const f = gated();
    f.observeTranscript(said("bob", "the build is red again", 0));
    f.noteVolitionOutcome(false);
    expect(f.observeTranscript(said("bob", "still red", 30_000))).toEqual({ action: "ignore" });
    expect(f.observeTranscript(said("bob", "yep still red", 60_000))).toEqual({
      action: "volition_gate_open",
    });
  });

  it("enforces the sliding hourly cap, reopening only as offers age out", () => {
    const f = gated();
    expect(f.observeTranscript(said("bob", "chatter", 0)).action).toBe("volition_gate_open");
    f.noteVolitionOutcome(false);
    expect(f.observeTranscript(said("bob", "chatter", 60_000)).action).toBe("volition_gate_open");
    f.noteVolitionOutcome(false);
    // Interval satisfied but two offers already sit inside the hour.
    expect(f.observeTranscript(said("bob", "chatter", 120_000))).toEqual({ action: "ignore" });
    // One ms past the first offer's hour: one slot frees up.
    expect(f.observeTranscript(said("bob", "chatter", 3_600_001)).action).toBe("volition_gate_open");
    expect(f.accounting()).toEqual({ offered: 3, taken: 0, suppressed: 2 });
  });

  it("never opens from a timer — silence costs nothing", () => {
    const f = gated();
    expect(f.tick(3_600_000)).toEqual({ action: "ignore" });
    expect(f.tick(7_200_000)).toEqual({ action: "ignore" });
    expect(f.accounting()).toEqual({ offered: 0, taken: 0, suppressed: 0 });
  });

  it("a maxPerHour of zero disables volition entirely", () => {
    const f = floor({ volition: { maxPerHour: 0 } });
    expect(f.observeTranscript(said("bob", "anything at all", 0))).toEqual({ action: "ignore" });
    expect(f.accounting()).toEqual({ offered: 0, taken: 0, suppressed: 0 });
  });

  it("derives its defaults from chattiness", () => {
    // The numbers themselves are the documented contract: unprompted speech
    // lands on humans, so the caps are load-bearing rather than tuning.
    expect(VOLITION_DEFAULTS).toEqual({
      quiet: { minIntervalMs: 600_000, maxPerHour: 2 },
      balanced: { minIntervalMs: 240_000, maxPerHour: 6 },
      chatty: { minIntervalMs: 90_000, maxPerHour: 15 },
    });
    const quiet = floor({ chattiness: "quiet", volition: {} });
    expect(quiet.observeTranscript(said("bob", "chatter", 0)).action).toBe("volition_gate_open");
    quiet.noteVolitionOutcome(false);
    expect(quiet.observeTranscript(said("bob", "chatter", 599_999))).toEqual({ action: "ignore" });
    expect(quiet.observeTranscript(said("bob", "chatter", 600_000)).action).toBe("volition_gate_open");
  });
});

describe("volition outcomes", () => {
  it("a taken offer engages the floor, held by whoever provoked the remark", () => {
    const f = floor({ volition: { minIntervalMs: 0, maxPerHour: 10 } });
    f.observeTranscript(said("bob", "ugh this deploy keeps failing", 0));
    expect(f.noteVolitionOutcome(true)).toEqual({ action: "wake", reason: "volition" });
    expect(f.state).toBe("engaged");
    expect(f.floorHolderId).toBe("bob");
    // Nameless reply is an offer: he may answer or stay quiet. Barge-in still
    // treats Bob as the holder.
    expect(f.observeTranscript(said("bob", "huh good point", 10_000))).toEqual({
      action: "offer",
      reason: "holder",
    });
    expect(f.accounting()).toEqual({ offered: 1, taken: 1, suppressed: 0 });
  });

  it("a suppressed offer stays dormant and is counted", () => {
    const f = floor({ volition: { minIntervalMs: 0, maxPerHour: 10 } });
    f.observeTranscript(said("bob", "the tests are flaky again", 0));
    expect(f.noteVolitionOutcome(false)).toEqual({ action: "ignore" });
    expect(f.state).toBe("dormant");
    expect(f.accounting()).toEqual({ offered: 1, taken: 0, suppressed: 1 });
  });

  it("an outcome with no outstanding offer changes nothing", () => {
    const f = floor();
    expect(f.noteVolitionOutcome(true)).toEqual({ action: "ignore" });
    expect(f.state).toBe("dormant");
    expect(f.accounting()).toEqual({ offered: 0, taken: 0, suppressed: 0 });
  });

  it("an addressed wake racing ahead of the outcome keeps the floor it won", () => {
    const f = floor({ volition: { minIntervalMs: 0, maxPerHour: 10 } });
    f.observeTranscript(said("bob", "the deploy is stuck", 0));
    f.observeTranscript(said("carol", "hey clankie", 1_000));
    // The offer really happened, so the accounting lands; the floor does not move.
    expect(f.noteVolitionOutcome(true)).toEqual({ action: "ignore" });
    expect(f.floorHolderId).toBe("carol");
    expect(f.accounting()).toEqual({ offered: 1, taken: 1, suppressed: 0 });
  });

  it("counters are monotonic and never exceed offers", () => {
    const f = floor({ volition: { minIntervalMs: 0, maxPerHour: 100 } });
    for (let i = 0; i < 5; i += 1) {
      const atMs = i * 120_000;
      f.observeTranscript(said("bob", "room chatter", atMs));
      f.noteVolitionOutcome(i % 2 === 0);
      // A duplicate outcome for the same offer must not double-count.
      f.noteVolitionOutcome(true);
      // Decay is the only way back to dormant, so the next round can be offered.
      if (f.state === "engaged") f.tick(atMs + WINDOW + 1);
    }
    const { offered, taken, suppressed } = f.accounting();
    expect(offered).toBe(5);
    expect(taken).toBe(3);
    expect(suppressed).toBe(2);
    expect(taken + suppressed).toBeLessThanOrEqual(offered);
  });
});

describe("options validation", () => {
  it("rejects windows and caps that would make the machine unsound", () => {
    expect(() => floor({ decayWindowMs: 0 })).toThrow(/decayWindowMs/u);
    expect(() => floor({ decayWindowMs: -1 })).toThrow(/decayWindowMs/u);
    expect(() => floor({ volition: { minIntervalMs: -1 } })).toThrow(/minIntervalMs/u);
    expect(() => floor({ volition: { maxPerHour: -1 } })).toThrow(/maxPerHour/u);
    expect(() => floor({ volition: { maxPerHour: 1.5 } })).toThrow(/maxPerHour/u);
  });
});
