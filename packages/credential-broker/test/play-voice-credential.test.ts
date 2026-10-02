import { MemoryCredentialStore } from "./memory-store.ts";
import { describe, expect, it } from "vitest";
import {
  PLAY_VOICE_CREDENTIAL_PROVIDER_ID,
  ensurePlayVoiceCredential,
  resolvePlayVoiceCredential,
} from "../src/play-voice-credential.ts";

describe("play voice credential", () => {
  it("mints the new provider once and leaves the old broker entry inert", async () => {
    const oldToken = `clankie_possessor_voice_${"x".repeat(43)}`;
    const store = new MemoryCredentialStore({ clankie_possessor_voice: { type: "api", key: oldToken } });
    const env = {} as NodeJS.ProcessEnv;

    await expect(resolvePlayVoiceCredential({ store, env })).resolves.toBeUndefined();
    const token = await ensurePlayVoiceCredential({ store, env });
    expect(token).toMatch(/^clankie_play_voice_[A-Za-z0-9_-]{43}$/u);
    expect(token).not.toBe(oldToken);
    await expect(ensurePlayVoiceCredential({ store, env })).resolves.toBe(token);
    expect(await store.get(PLAY_VOICE_CREDENTIAL_PROVIDER_ID)).toEqual({ type: "api", key: token });
  });

  it("rejects mismatched stored credentials and the forbidden environment token", async () => {
    const store = new MemoryCredentialStore({
      [PLAY_VOICE_CREDENTIAL_PROVIDER_ID]: { type: "api", key: `clankie_other_voice_${"x".repeat(43)}` },
    });
    await expect(resolvePlayVoiceCredential({ store, env: {} as NodeJS.ProcessEnv })).rejects.toThrow(
      /invalid; refusing to use it/u,
    );
    await expect(
      resolvePlayVoiceCredential({
        store: new MemoryCredentialStore(),
        env: { CLANKIE_PLAY_VOICE_TOKEN: `clankie_play_voice_${"x".repeat(43)}` },
      }),
    ).rejects.toThrow(/CLANKIE_PLAY_VOICE_TOKEN must not be set/u);
  });
});
