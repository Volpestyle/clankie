import { describe, expect, it, vi } from "vitest";
import { CLANKIE_SPEECH_MAX, deniedSpeechPort, type ClankieSpeechPort } from "../src/speech.ts";

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
