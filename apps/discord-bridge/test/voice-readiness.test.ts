import type { DiscordControlPlaneReadiness } from "@clankie/api-client";
import {
  DISCORD_BOT_PROVIDER_ID,
  DISCORD_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID,
  mintDiscordVoiceBridgeToken,
  type CredentialStore,
  type ProviderCredential,
} from "@clankie/credential-broker";
import { Routes } from "discord.js";
import { describe, expect, it } from "vitest";
import { inspectDiscordVoiceReadiness } from "../src/voice-readiness.ts";

class MemoryCredentialStore implements CredentialStore {
  public readonly credentials = new Map<string, ProviderCredential>();
  public get(providerId: string): Promise<ProviderCredential | undefined> {
    return Promise.resolve(this.credentials.get(providerId));
  }
  public set(providerId: string, credential: ProviderCredential): Promise<void> {
    this.credentials.set(providerId, credential);
    return Promise.resolve();
  }
  public delete(providerId: string): Promise<boolean> {
    return Promise.resolve(this.credentials.delete(providerId));
  }
  public list(): Promise<Record<string, never>> {
    return Promise.resolve({});
  }
}

const controlPlane: DiscordControlPlaneReadiness = {
  schemaVersion: 1,
  ready: true,
  service: "clankie-control-plane",
  instanceId: "boot-1",
  profileHash: "profile",
  checks: { captainChannelTurns: true, discordPresenceRuntime: true, eventStore: true },
};

describe("Discord group voice readiness", () => {
  it("proves the brokered bot, isolated voice identity, speech, Opus, and live guild", async () => {
    const store = new MemoryCredentialStore();
    store.credentials.set(DISCORD_BOT_PROVIDER_ID, { type: "api", key: "bot-secret" });
    store.credentials.set(DISCORD_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID, {
      type: "api",
      key: mintDiscordVoiceBridgeToken(() => Buffer.alloc(32, 6)),
    });
    store.credentials.set("openai", { type: "api", key: "openai-secret" });
    const env = {
      DISCORD_VOICE_ENABLED: "true",
      DISCORD_APPLICATION_ID: "111111111111111111",
      DISCORD_GUILD_ID: "222222222222222222",
      DISCORD_VOICE_CHANNEL_ID: "333333333333333333",
      DISCORD_VOICE_GUILD_IDS: "222222222222222222",
      DISCORD_VOICE_CHANNEL_IDS: "333333333333333333",
    };
    const report = await inspectDiscordVoiceReadiness({
      env,
      store,
      api: { inspectDiscordReadiness: () => Promise.resolve(controlPlane) },
      speech: {
        readiness: () =>
          Promise.resolve({
            ready: true,
            provider: "openai",
            sttModel: "gpt-4o-mini-transcribe",
            ttsModel: "gpt-4o-mini-tts",
            voice: "marin",
            responseFormat: "pcm",
          }),
        transcribe: () => Promise.resolve("unused"),
        synthesize: () => Promise.reject(new Error("unused")),
      },
      opusAvailable: () => true,
      rest: {
        get: (route) =>
          Promise.resolve(
            route === Routes.currentApplication()
              ? { id: env.DISCORD_APPLICATION_ID, name: "private-app-name" }
              : { user: { username: "private-user-name" } },
          ),
      },
      clock: () => new Date("2026-07-25T17:00:00.000Z"),
    });
    expect(report.ready).toBe(true);
    expect(JSON.stringify(report)).not.toContain("bot-secret");
    expect(JSON.stringify(report)).not.toContain("openai-secret");
    expect(JSON.stringify(report)).not.toContain("private-app-name");
    expect(JSON.stringify(report)).not.toContain("private-user-name");
  });

  it("fails closed when voice, speech, credentials, or control plane are absent", async () => {
    const report = await inspectDiscordVoiceReadiness({
      env: {},
      store: new MemoryCredentialStore(),
      api: { inspectDiscordReadiness: () => Promise.reject(new Error("offline")) },
      speech: {
        readiness: () =>
          Promise.resolve({
            ready: false,
            provider: "openai",
            sttModel: "gpt-4o-mini-transcribe",
            ttsModel: "gpt-4o-mini-tts",
            voice: "marin",
            responseFormat: "pcm",
          }),
        transcribe: () => Promise.resolve(undefined),
        synthesize: () => Promise.reject(new Error("unused")),
      },
      opusAvailable: () => false,
    });
    expect(report.ready).toBe(false);
    expect(report.checks.filter((check) => !check.ok).length).toBeGreaterThan(5);
  });
});
