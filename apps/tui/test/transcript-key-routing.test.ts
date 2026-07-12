import { describe, expect, it } from "vitest";
import { shouldRouteClankieTranscriptGlobalInput } from "../src/face/clankie-transcript-key-routing.ts";

const idle = {
  commandPaletteFocused: false,
  editorAutocompleteOpen: false,
  editorText: "",
  setupWaiting: false,
  transcriptFocused: false,
};

describe("shouldRouteClankieTranscriptGlobalInput", () => {
  it("routes page, wheel, and alt shortcuts while the prompt is empty", () => {
    expect(shouldRouteClankieTranscriptGlobalInput("\x1b[5~", idle)).toBe(true);
    expect(shouldRouteClankieTranscriptGlobalInput("\x1b[6~", idle)).toBe(true);
    expect(shouldRouteClankieTranscriptGlobalInput("\x1b[<64;10;5M", idle)).toBe(true);
    expect(shouldRouteClankieTranscriptGlobalInput("\x1b[<65;10;5M", idle)).toBe(true);
    expect(shouldRouteClankieTranscriptGlobalInput("\x1b[1;3A", idle)).toBe(true);
  });

  it("keeps draft-safe scrolling but leaves alt shortcuts to the editor while typing", () => {
    const withDraft = { ...idle, editorText: "draft prompt" };
    expect(shouldRouteClankieTranscriptGlobalInput("\x1b[5~", withDraft)).toBe(true);
    expect(shouldRouteClankieTranscriptGlobalInput("\x1b[6~", withDraft)).toBe(true);
    expect(shouldRouteClankieTranscriptGlobalInput("\x1b[<64;10;5M", withDraft)).toBe(true);
    expect(shouldRouteClankieTranscriptGlobalInput("\x1b[<65;10;5M", withDraft)).toBe(true);
    expect(
      shouldRouteClankieTranscriptGlobalInput("\x1b[1;3A", withDraft),
      "alt-up should not steal keys while editing",
    ).toBe(false);
    expect(
      shouldRouteClankieTranscriptGlobalInput("\x1b\r", withDraft),
      "alt-enter should not steal keys while editing",
    ).toBe(false);
  });

  it("lets setup prompts, the command palette, autocomplete, and focused transcripts own keys", () => {
    expect(shouldRouteClankieTranscriptGlobalInput("\x1b[5~", { ...idle, setupWaiting: true })).toBe(false);
    expect(shouldRouteClankieTranscriptGlobalInput("\x1b[5~", { ...idle, commandPaletteFocused: true })).toBe(
      false,
    );
    expect(
      shouldRouteClankieTranscriptGlobalInput("\x1b[5~", { ...idle, editorAutocompleteOpen: true }),
    ).toBe(false);
    expect(
      shouldRouteClankieTranscriptGlobalInput("\x1b[<64;10;5M", { ...idle, editorAutocompleteOpen: true }),
    ).toBe(false);
    expect(shouldRouteClankieTranscriptGlobalInput("\x1b[5~", { ...idle, transcriptFocused: true })).toBe(
      false,
    );
  });
});
