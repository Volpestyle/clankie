import type { DiscordControlPlaneReadiness, DiscordVoiceBriefing } from "@clankie/api-client";
import {
  DISCORD_BOT_PROVIDER_ID,
  DISCORD_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID,
  mintDiscordVoiceBridgeToken,
  type CredentialStore,
  type ProviderCredential,
} from "@clankie/credential-broker";
import { Buffer } from "node:buffer";
import { Routes } from "discord.js";
import { describe, expect, it } from "vitest";
import type { RealtimeSocket, RealtimeSocketFactory } from "@clankie/discord-presence-core";
import { parseVoiceRealtimeEnv } from "../src/voice-composition.ts";
import { inspectDiscordVoiceReadiness, probeVoiceWakeTransition } from "../src/voice-readiness.ts";

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
  service: "clankie",
  instanceId: "boot-1",
  profileHash: "profile",
  checks: { captainChannelTurns: true, discordPresenceRuntime: true },
};

const briefing: DiscordVoiceBriefing = {
  schemaVersion: 1,
  instructions: "Be Clankie in the social register. Private composed instructions.",
  briefing: "Right now: private composed self-state.",
  refreshedAt: "2026-07-25T17:00:00.000Z",
};

function checkByName(
  report: { checks: readonly { name: string; ok: boolean; detail: string }[] },
  name: string,
): { name: string; ok: boolean; detail: string } {
  const check = report.checks.find((candidate) => candidate.name === name);
  expect(check, `report has no check named ${name}`).toBeDefined();
  return check as { name: string; ok: boolean; detail: string };
}

describe("Discord group voice readiness", () => {
  it("proves credentials, realtime config, briefing path, wake transition, Opus, and live guild", async () => {
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
    const briefingRequests: unknown[] = [];
    const report = await inspectDiscordVoiceReadiness({
      env,
      store,
      api: {
        inspectDiscordReadiness: () => Promise.resolve(controlPlane),
        fetchDiscordVoiceBriefing: (input) => {
          briefingRequests.push(input);
          return Promise.resolve(briefing);
        },
      },
      opusAvailable: () => true,
      // The live probe is faked so unit readiness stays offline; the CLI path
      // builds the real one.
      wakeProbe: () =>
        Promise.resolve({
          listener: { ok: true, detail: "dormant transcription session opened cleanly" },
          engaged: { ok: true, detail: "conversation session opened and produced a response" },
          capability: { ok: true, detail: "web lookup routed through ask_clankie" },
        }),
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
    // The briefing path is exercised end-to-end with zero consented ids, so a
    // readiness run touches nobody's person memory.
    expect(briefingRequests).toEqual([
      {
        schemaVersion: 1,
        guildId: env.DISCORD_GUILD_ID,
        channelId: env.DISCORD_VOICE_CHANNEL_ID,
        consentedUserIds: [],
      },
    ]);
    // The wake transition is reported as separate checks (ADR 0057: readiness
    // exercises dormant→engaged, not one session round trip).
    expect(checkByName(report, "listener session").ok).toBe(true);
    expect(checkByName(report, "engaged session").ok).toBe(true);
    expect(checkByName(report, "captain capability routing").ok).toBe(true);
    expect(checkByName(report, "wake transition").ok).toBe(true);
    expect(checkByName(report, "voice briefing endpoint").ok).toBe(true);
    // The realtime echo replaces the cascade's speech readiness: content-free
    // provider/model/truncation scalars only.
    expect(report.realtime).toEqual({
      provider: "openai",
      transcribeModel: "gpt-realtime-whisper",
      realtimeModel: "gpt-realtime-2.1",
      voice: "marin",
      ttsProvider: "openai",
      truncationRetentionRatio: 0.7,
      postInstructionsTokenLimit: 12_000,
    });
    // The native-voice report carries no vendor check it does not need.
    expect(report.checks.some((check) => check.name === "ElevenLabs voice credential")).toBe(false);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("bot-secret");
    expect(serialized).not.toContain("openai-secret");
    expect(serialized).not.toContain("private-app-name");
    expect(serialized).not.toContain("private-user-name");
    // The briefing content is control-plane-composed conversation material and
    // must never enter a readiness report — only its lengths do.
    expect(serialized).not.toContain("social register");
    expect(serialized).not.toContain("self-state");
  });

  it("fails closed when voice, credentials, config, or the control plane are absent", async () => {
    const report = await inspectDiscordVoiceReadiness({
      env: {},
      store: new MemoryCredentialStore(),
      api: {
        inspectDiscordReadiness: () => Promise.reject(new Error("offline")),
        fetchDiscordVoiceBriefing: () => Promise.reject(new Error("offline")),
      },
      opusAvailable: () => false,
    });
    expect(report.ready).toBe(false);
    expect(report.checks.filter((check) => !check.ok).length).toBeGreaterThan(5);
    // No brokered openai credential means the live probe is skipped as failed
    // checks rather than attempted.
    expect(checkByName(report, "listener session").ok).toBe(false);
    expect(checkByName(report, "engaged session").ok).toBe(false);
    expect(checkByName(report, "captain capability routing").ok).toBe(false);
    expect(checkByName(report, "wake transition").ok).toBe(false);
    expect(checkByName(report, "voice briefing endpoint").ok).toBe(false);
  });

  it("checks the ElevenLabs credential exactly when the external voice is configured (ADR 0070)", async () => {
    const store = new MemoryCredentialStore();
    store.credentials.set("openai", { type: "api", key: "openai-secret" });
    const env = {
      DISCORD_VOICE_ENABLED: "true",
      CLANKIE_VOICE_TTS_PROVIDER: "elevenlabs",
      CLANKIE_VOICE_ELEVENLABS_VOICE_ID: "voice_abc123",
    };
    const api = {
      inspectDiscordReadiness: () => Promise.resolve(controlPlane),
      fetchDiscordVoiceBriefing: () => Promise.resolve(briefing),
    };
    const wakeProbe = () =>
      Promise.resolve({
        listener: { ok: true, detail: "dormant transcription session opened cleanly" },
        engaged: { ok: true, detail: "conversation session opened and produced a response" },
        capability: { ok: true, detail: "web lookup routed through ask_clankie" },
      });
    const missing = await inspectDiscordVoiceReadiness({
      env,
      store,
      api,
      opusAvailable: () => true,
      wakeProbe,
    });
    const credentialCheck = checkByName(missing, "ElevenLabs voice credential");
    expect(credentialCheck.ok).toBe(false);
    expect(missing.realtime.ttsProvider).toBe("elevenlabs");
    expect(missing.realtime.elevenLabsVoiceId).toBe("voice_abc123");
    expect(checkByName(missing, "realtime configuration").detail).toContain("elevenlabs TTS voice_abc123");

    store.credentials.set("elevenlabs", { type: "api", key: "elevenlabs-secret" });
    const present = await inspectDiscordVoiceReadiness({
      env,
      store,
      api,
      opusAvailable: () => true,
      wakeProbe,
    });
    expect(checkByName(present, "ElevenLabs voice credential").ok).toBe(true);
    expect(JSON.stringify(present)).not.toContain("elevenlabs-secret");
  });

  it("checks and reports the selected xAI voice provider", async () => {
    const store = new MemoryCredentialStore();
    store.credentials.set("xai", { type: "api", key: "xai-secret" });
    const report = await inspectDiscordVoiceReadiness({
      env: { DISCORD_VOICE_ENABLED: "true", CLANKIE_VOICE_REALTIME_PROVIDER: "xai" },
      store,
      api: {
        inspectDiscordReadiness: () => Promise.resolve(controlPlane),
        fetchDiscordVoiceBriefing: () => Promise.resolve(briefing),
      },
      opusAvailable: () => true,
      wakeProbe: () =>
        Promise.resolve({
          listener: { ok: true, detail: "xAI streaming STT opened" },
          engaged: { ok: true, detail: "Grok Voice responded" },
          capability: { ok: true, detail: "web lookup routed through ask_clankie" },
        }),
    });
    expect(checkByName(report, "xai realtime credential").ok).toBe(true);
    expect(report.realtime).toMatchObject({
      provider: "xai",
      transcribeModel: "xai-streaming-stt",
      realtimeModel: "grok-voice-think-fast-2.0",
      voice: "eve",
    });
    expect(JSON.stringify(report)).not.toContain("xai-secret");
  });

  it("fails the realtime configuration check when retired cascade envs are set", async () => {
    const store = new MemoryCredentialStore();
    store.credentials.set("openai", { type: "api", key: "openai-secret" });
    const report = await inspectDiscordVoiceReadiness({
      env: { DISCORD_VOICE_ENABLED: "true", CLANKIE_VOICE_TTS_MODEL: "gpt-4o-mini-tts" },
      store,
      api: {
        inspectDiscordReadiness: () => Promise.resolve(controlPlane),
        fetchDiscordVoiceBriefing: () => Promise.resolve(briefing),
      },
      opusAvailable: () => true,
    });
    expect(report.ready).toBe(false);
    const config = checkByName(report, "realtime configuration");
    expect(config.ok).toBe(false);
    expect(config.detail).toContain("CLANKIE_VOICE_TTS_MODEL");
  });
});

// ---------------------------------------------------------------------------
// The wake-transition probe itself, offline over a fake socket factory: the
// real session classes run, only the transport is injected.
// ---------------------------------------------------------------------------

class FakeProbeSocket implements RealtimeSocket {
  public readonly sent: string[] = [];
  private readonly messageHandlers: ((data: string) => void)[] = [];
  private readonly closeHandlers: (() => void)[] = [];
  private readonly routeCapability: boolean;

  public constructor(routeCapability = true) {
    this.routeCapability = routeCapability;
  }

  public send(data: string | Uint8Array): void {
    if (typeof data !== "string") return;
    this.sent.push(data);
    const frame = JSON.parse(data) as { type?: string };
    if (frame.type === "response.create") {
      queueMicrotask(() => {
        if (this.routeCapability) {
          this.serverEvent({
            type: "response.output_item.done",
            item: {
              type: "function_call",
              call_id: "call_1",
              name: "ask_clankie",
              arguments: '{"request":"look up the current weather in Chicago"}',
            },
          });
          this.serverEvent({
            type: "response.function_call_arguments.done",
            call_id: "call_1",
            name: "ask_clankie",
            arguments: '{"request":"look up the current weather in Chicago"}',
          });
        }
        this.serverEvent({ type: "response.done", response: { id: "resp_1", status: "completed" } });
      });
    }
  }

  public close(): void {
    for (const handler of this.closeHandlers) handler();
  }

  public onMessage(handler: (data: string) => void): void {
    this.messageHandlers.push(handler);
  }

  public onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  public onError(): void {
    // The probe never exercises transport errors in this fake.
  }

  public serverEvent(event: Record<string, unknown>): void {
    for (const handler of this.messageHandlers) handler(JSON.stringify(event));
  }
}

describe("voice wake-transition probe", () => {
  it("opens the listener, then the engaged session, responds, and closes both", async () => {
    const sockets: FakeProbeSocket[] = [];
    const socketFactory: RealtimeSocketFactory = (url, headers) => {
      expect(headers.authorization).toBe("Bearer probe-key");
      expect(url.startsWith("wss://api.openai.com/v1/realtime")).toBe(true);
      const socket = new FakeProbeSocket();
      sockets.push(socket);
      return Promise.resolve(socket);
    };
    const result = await probeVoiceWakeTransition({
      apiKey: "probe-key",
      config: parseVoiceRealtimeEnv({}),
      socketFactory,
      timeoutMs: 1_000,
    });
    expect(result.listener.ok).toBe(true);
    expect(result.engaged.ok).toBe(true);
    expect(result.capability.ok).toBe(true);
    // Two sessions in sequence: the dormant listener first, the engaged
    // conversation second — the wake transition, not one round trip.
    expect(sockets).toHaveLength(2);
    const listenerUpdate = JSON.parse(sockets[0]?.sent[0] ?? "{}") as {
      session?: { type?: string };
    };
    expect(listenerUpdate.session?.type).toBe("transcription");
    const conversationFrames = (sockets[1]?.sent ?? []).map(
      (frame) => (JSON.parse(frame) as { type: string }).type,
    );
    expect(conversationFrames).toContain("session.update");
    expect(conversationFrames).toContain("conversation.item.create");
    expect(conversationFrames).toContain("response.create");
  });

  it("probes the engaged session in text modality when the external voice is configured", async () => {
    const sockets: FakeProbeSocket[] = [];
    const socketFactory: RealtimeSocketFactory = (url) => {
      // Both probe sessions are realtime sessions; the ElevenLabs socket is
      // deliberately never opened by readiness.
      expect(url.startsWith("wss://api.openai.com/v1/realtime")).toBe(true);
      const socket = new FakeProbeSocket();
      sockets.push(socket);
      return Promise.resolve(socket);
    };
    const result = await probeVoiceWakeTransition({
      apiKey: "probe-key",
      config: parseVoiceRealtimeEnv({
        CLANKIE_VOICE_TTS_PROVIDER: "elevenlabs",
        CLANKIE_VOICE_ELEVENLABS_VOICE_ID: "voice_abc123",
      }),
      socketFactory,
      timeoutMs: 1_000,
    });
    expect(result.listener.ok).toBe(true);
    expect(result.engaged.ok).toBe(true);
    expect(result.capability.ok).toBe(true);
    expect(sockets).toHaveLength(2);
    const engagedUpdate = JSON.parse(sockets[1]?.sent[0] ?? "{}") as {
      session?: { output_modalities?: string[]; audio?: { output?: unknown } };
    };
    expect(engagedUpdate.session?.output_modalities).toEqual(["text"]);
    expect(engagedUpdate.session?.audio?.output).toBeUndefined();
  });

  it("probes xAI streaming STT then Grok Voice", async () => {
    const urls: string[] = [];
    const result = await probeVoiceWakeTransition({
      apiKey: "probe-key",
      config: parseVoiceRealtimeEnv({ CLANKIE_VOICE_REALTIME_PROVIDER: "xai" }),
      socketFactory: (url) => {
        urls.push(url);
        return Promise.resolve(new FakeProbeSocket());
      },
      timeoutMs: 1_000,
    });
    expect(result.listener.ok).toBe(true);
    expect(result.engaged.ok).toBe(true);
    expect(result.capability.ok).toBe(true);
    expect(urls[0]).toContain("wss://api.x.ai/v1/stt");
    expect(urls[1]).toContain("wss://api.x.ai/v1/realtime");
  });

  it("reports the engaged stage as not attempted when the listener cannot open", async () => {
    const result = await probeVoiceWakeTransition({
      apiKey: "probe-key",
      config: parseVoiceRealtimeEnv({}),
      socketFactory: () => Promise.reject(new Error("connection refused")),
      timeoutMs: 1_000,
    });
    expect(result.listener.ok).toBe(false);
    expect(result.engaged.ok).toBe(false);
    expect(result.capability.ok).toBe(false);
    expect(result.engaged.detail).toContain("not attempted");
  });

  it("fails capability routing when the realtime model answers the web lookup directly", async () => {
    let socketIndex = 0;
    const result = await probeVoiceWakeTransition({
      apiKey: "probe-key",
      config: parseVoiceRealtimeEnv({}),
      socketFactory: () => Promise.resolve(new FakeProbeSocket(socketIndex++ === 0)),
      timeoutMs: 1_000,
    });
    expect(result.listener.ok).toBe(true);
    expect(result.engaged.ok).toBe(true);
    expect(result.capability.ok).toBe(false);
    expect(result.capability.detail).toContain("without ask_clankie");
  });
});
