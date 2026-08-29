import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("user-session play voice wiring", () => {
  it("hosts the same fixed listener while this body owns the voice session", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
    };

    expect(manifest.dependencies).toHaveProperty("@clankie/play-voice");
    expect(source).toContain("startPlayVoiceListener");
    expect(source).toContain("ensurePlayVoiceCredential({ store: credentialStore })");
    expect(source).toContain("voiceSession.narrate(text, options)");
    expect(source).toContain("voiceSession.subscribeTranscript");
    expect(source).toContain("playVoiceListener?.publishUtterance(routedRoomText.text)");
    expect(source).toContain("playVoiceListener?.publishRoom");
    expect(source).toContain("await playVoiceListener?.close()");

    const startAt = source.indexOf("await startPlayVoiceListener");
    expect(source).toContain(
      "voiceSession === undefined\n    ? undefined\n    : await startPlayVoiceListener",
    );
    expect(startAt).toBeGreaterThan(-1);
    expect(startAt).toBeLessThan(source.indexOf("gateway.open()"));
  });
});
