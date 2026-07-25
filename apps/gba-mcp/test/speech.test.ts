import { describe, expect, it, vi } from "vitest";
import {
  CLANKIE_HEARING_MAX_LINES,
  CLANKIE_SPEECH_MAX,
  deniedHearingPort,
  deniedSpeechPort,
  PossessorHearing,
  type ClankieHearingPort,
  type ClankieSpeechPort,
} from "../src/speech.ts";

describe("clankie speech", () => {
  it("refuses by default, and says why rather than failing opaquely", async () => {
    // A possessor holds no gateway, so it holds no live presence claim — the
    // fence that stops an action reaching a session that is not live.
    await expect(deniedSpeechPort.say("hello")).rejects.toThrow(/clankie_speech_unavailable/);
    await expect(deniedSpeechPort.say("hello")).rejects.toThrow(/live claim/);
  });

  it("bounds what can be said in one go", () => {
    // Discord's own message limit; speaking as him is not a firehose.
    expect(CLANKIE_SPEECH_MAX).toBe(2_000);
  });

  it("accepts a wired port without knowing how it reaches Discord", async () => {
    const say = vi.fn((_text: string) => Promise.resolve());
    const port: ClankieSpeechPort = { say };
    await expect(port.say("hi")).resolves.toBeUndefined();
    expect(say).toHaveBeenCalledWith("hi");
  });
});

describe("clankie hearing", () => {
  it("refuses by default, blocked by the same gateway fence as speech", () => {
    // The bridge holds both the gateway and the consent registry; a possessor
    // holds neither, so it cannot subscribe to voice itself.
    expect(() => deniedHearingPort.subscribe(() => undefined)).toThrow(/clankie_hearing_unavailable/);
    expect(() => deniedHearingPort.subscribe(() => undefined)).toThrow(/consent registry/);
  });

  it("keeps retention on the possessor and drops it on release", () => {
    // Pull would have forced the bridge to retain transcripts it deliberately
    // does not keep, so utterances are pushed and held only while possessing.
    let emit: ((line: string) => void) | undefined;
    let unsubscribed = false;
    const port: ClankieHearingPort = {
      subscribe: (listener) => {
        emit = listener;
        return () => {
          unsubscribed = true;
        };
      },
    };
    const hearing = new PossessorHearing(port, 2);
    hearing.start();
    emit?.("one");
    emit?.("two");
    emit?.("three");
    // Bounded: the oldest falls off rather than growing without limit.
    expect(hearing.recent(10)).toEqual(["two", "three"]);

    hearing.stop();
    expect(unsubscribed).toBe(true);
    // What was heard does not outlive the possession that heard it.
    expect(hearing.recent(10)).toEqual([]);
  });

  it("bounds how much can be pulled at once", () => {
    expect(CLANKIE_HEARING_MAX_LINES).toBe(50);
  });

  it("carries transcript lines, never audio", () => {
    const received: string[] = [];
    const port: ClankieHearingPort = {
      subscribe: (listener) => {
        listener("someone said hello");
        return () => undefined;
      },
    };
    port.subscribe((line) => received.push(line));
    // Strings only: raw audio never crosses this seam.
    expect(received.every((line) => typeof line === "string")).toBe(true);
  });
});
