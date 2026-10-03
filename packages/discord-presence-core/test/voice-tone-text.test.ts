import { expect, it } from "vitest";
import { VoiceToneText, VOICE_TONE_TAGS } from "../src/voice-tone-text.ts";

it.each([true, false])(
  "projects arbitrary chunk boundaries with exactly the approved tags (v4=%s)",
  (expressive) => {
    const input = VOICE_TONE_TAGS.map((tag) => `[${tag}] Word.`).join(" ") + " [made-up] End.";
    for (let split = 0; split <= input.length; split++) {
      const parser = new VoiceToneText(expressive);
      const parts = [parser.append(input.slice(0, split)), parser.append(input.slice(split))];
      expect(parts.map((part) => part.readable).join("")).toBe(
        "Word. Word. Word. Word. Word. Word. Word. Word. End.",
      );
      expect(parts.map((part) => part.speech).join("")).toBe(
        expressive ? input.replace("[made-up]", "") : input.replace(/\[[^\]]*\]/gu, ""),
      );
    }
  },
);
it("withholds every partial tag, including malformed/nested/oversized directions", () => {
  const parser = new VoiceToneText(true);
  let speech = "",
    readable = "";
  for (const chunk of ["[", "lau", "ghs]", " A ", "[" + "x".repeat(10000), "] B", " [[sighs]]", " C [whis"]) {
    const result = parser.append(chunk);
    speech += result.speech;
    readable += result.readable;
  }
  expect(speech).toBe("[laughs] A  B  C ");
  expect(readable).toBe("A B C");
});
it("requires exact spelling and exposes no readable event for directions alone", () => {
  const parser = new VoiceToneText(true);
  expect(parser.append("[LAUGHS][ laughs ][laugh][laughs]")).toEqual({ speech: "[laughs]", readable: "" });
});
