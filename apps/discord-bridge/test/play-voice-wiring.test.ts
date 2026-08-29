import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("official bot play voice wiring", () => {
  it("hosts the fixed listener for its voice session and closes every attachment", async () => {
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
    expect(source).not.toContain("CLANKIE_POSSESSOR_VOICE");

    const startAt = source.indexOf("await startPlayVoiceListener");
    expect(source).toContain(
      "voiceSession === undefined\n    ? undefined\n    : await startPlayVoiceListener",
    );
    expect(startAt).toBeGreaterThan(-1);
    expect(startAt).toBeLessThan(source.indexOf("await client.login(token)"));
  });
});
