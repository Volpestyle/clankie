import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("user-session play voice wiring", () => {
  it("hosts the same fixed listener while this body owns the voice session", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
    };

    expect(manifest.dependencies).toHaveProperty("@clankie/play-voice");
    expect(source).toContain("createPlayVoiceListener");
    expect(source).toContain("ensurePlayVoiceCredential({ store: credentialStore })");
    expect(source).toContain("playVoiceListener.listen(PLAY_VOICE_DEFAULT_PORT)");
    expect(source).toContain("voiceSession.narrate(text, options)");
    expect(source).toContain("voiceSession.subscribeTranscript");
    expect(source).toContain("playVoiceListener?.publishUtterance(routedRoomText.text)");
    expect(source).toContain("playVoiceListener?.publishRoom");
    expect(source).toContain("await playVoiceListener?.close()");

    const listenAt = source.indexOf("await playVoiceListener.listen(PLAY_VOICE_DEFAULT_PORT)");
    expect(source).toContain("voiceSession === undefined\n    ? undefined\n    : createPlayVoiceListener");
    expect(listenAt).toBeGreaterThan(-1);
    expect(listenAt).toBeLessThan(source.indexOf("voiceSession.subscribeTranscript", listenAt));
    expect(listenAt).toBeLessThan(source.indexOf("gateway.open()"));
  });
});
