import { describe, expect, it } from "vitest";
import type { CredentialStore } from "../src/credential-store.ts";
import {
  PLAY_VOICE_CREDENTIAL_PROVIDER_ID,
  ensurePlayVoiceCredential,
  resolvePlayVoiceCredential,
} from "../src/play-voice-credential.ts";

function memoryStore(initial: Readonly<Record<string, string>> = {}): CredentialStore {
  const entries = new Map(Object.entries(initial).map(([id, key]) => [id, { type: "api", key }]));
  return {
    get: (id: string) => Promise.resolve(entries.get(id) as never),
    set: (id: string, credential: { type: string; key: string }) => {
      entries.set(id, credential as { type: string; key: string });
      return Promise.resolve();
    },
    delete: (id: string) => Promise.resolve(entries.delete(id)),
    list: () => Promise.resolve([...entries.keys()]),
  } as unknown as CredentialStore;
}

describe("play voice credential", () => {
  it("mints the new provider once and leaves the old broker entry inert", async () => {
    const oldToken = `clankie_possessor_voice_${"x".repeat(43)}`;
    const store = memoryStore({ clankie_possessor_voice: oldToken });
    const env = {} as NodeJS.ProcessEnv;

    await expect(resolvePlayVoiceCredential({ store, env })).resolves.toBeUndefined();
    const token = await ensurePlayVoiceCredential({ store, env });
    expect(token).toMatch(/^clankie_play_voice_[A-Za-z0-9_-]{43}$/u);
    expect(token).not.toBe(oldToken);
    await expect(ensurePlayVoiceCredential({ store, env })).resolves.toBe(token);
    expect(await store.get(PLAY_VOICE_CREDENTIAL_PROVIDER_ID)).toEqual({ type: "api", key: token });
  });

  it("rejects mismatched stored credentials and the forbidden environment token", async () => {
    const store = memoryStore({
      [PLAY_VOICE_CREDENTIAL_PROVIDER_ID]: `clankie_other_voice_${"x".repeat(43)}`,
    });
    await expect(resolvePlayVoiceCredential({ store, env: {} as NodeJS.ProcessEnv })).rejects.toThrow(
      /invalid; refusing to use it/u,
    );
    await expect(
      resolvePlayVoiceCredential({
        store: memoryStore(),
        env: { CLANKIE_PLAY_VOICE_TOKEN: `clankie_play_voice_${"x".repeat(43)}` },
      }),
    ).rejects.toThrow(/CLANKIE_PLAY_VOICE_TOKEN must not be set/u);
  });
});
