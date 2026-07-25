import { describe, expect, it, vi } from "vitest";
import {
  CLANKIE_HEARING_MAX_LINES,
  CLANKIE_SPEECH_MAX,
  deniedHearingPort,
  deniedSpeechPort,
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
  it("refuses by default, blocked by the same gateway fence as speech", async () => {
    await expect(deniedHearingPort.recent(10)).rejects.toThrow(/clankie_hearing_unavailable/);
    // The bridge holds both the gateway and the consent registry; a possessor
    // holds neither, so it cannot subscribe to voice itself.
    await expect(deniedHearingPort.recent(10)).rejects.toThrow(/consent registry/);
  });

  it("bounds how much can be pulled at once", () => {
    expect(CLANKIE_HEARING_MAX_LINES).toBe(50);
  });

  it("takes transcript lines, never audio", async () => {
    const port: ClankieHearingPort = { recent: (limit) => Promise.resolve(["hi".repeat(limit)]) };
    const lines = await port.recent(1);
    // Strings only: raw audio never crosses this seam.
    expect(lines.every((line) => typeof line === "string")).toBe(true);
  });
});
