import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DiscordSettingsSchema,
  EmailSettingsSchema,
  GameplaySettingsSchema,
  McpServerSchema,
  VoiceSettingsSchema,
  applyDiscordSettingsToEnvironment,
  applyVoiceSettingsToEnvironment,
  SettingsStore,
  assertNoSecretShapedValue,
  defaultSettingsPath,
  discordSettingsToEnvironment,
  emptySettings,
  resolveDiscordSettings,
  resolveVoiceSettings,
  voiceSettingsToEnvironment,
} from "../src/index.ts";

async function tempStore(): Promise<SettingsStore> {
  const directory = await mkdtemp(join(tmpdir(), "clankie-settings-"));
  return new SettingsStore(join(directory, "settings.json"));
}

describe("settings store", () => {
  it("configures solo Pokemon and PokeAgent MMO independently", () => {
    expect(GameplaySettingsSchema.parse({})).toEqual({
      pokemonEmulatorEnabled: true,
      pokeagentMmoEnabled: true,
    });
    expect(GameplaySettingsSchema.parse({ pokemonEmulatorEnabled: false })).toEqual({
      pokemonEmulatorEnabled: false,
      pokeagentMmoEnabled: true,
    });
  });

  it("returns defaults when no file exists and persists mode 0600", async () => {
    const store = await tempStore();
    expect(await store.load()).toEqual(emptySettings());

    await store.update((current) => ({
      ...current,
      discord: { ...current.discord, guildId: "123456789012345678" },
    }));

    const mode = (await stat(store.path)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect((await store.load()).discord.guildId).toBe("123456789012345678");
  });

  it("serializes concurrent updates instead of losing one", async () => {
    const store = await tempStore();
    await Promise.all([
      store.update((c) => ({ ...c, discord: { ...c.discord, guildId: "111111111111111111" } })),
      store.update((c) => ({ ...c, discord: { ...c.discord, applicationId: "222222222222222222" } })),
    ]);
    const loaded = await store.load();
    // Neither write may clobber the other.
    expect(loaded.discord.guildId).toBe("111111111111111111");
    expect(loaded.discord.applicationId).toBe("222222222222222222");
  });

  it("fails loudly on a malformed file rather than reverting to defaults", async () => {
    const store = await tempStore();
    await store.update((c) => c);
    await writeFile(store.path, "{ not json", "utf8");
    await expect(store.load()).rejects.toThrow(/invalid_json/);
  });

  it("rejects a non-snowflake id", async () => {
    const store = await tempStore();
    await expect(
      store.update((c) => ({ ...c, discord: { ...c.discord, guildId: "not-an-id" } })),
    ).rejects.toThrow();
  });

  it("rejects an unknown key before it can carry a secret", async () => {
    const store = await tempStore();
    // `.strict()` is the first line of defence: no field in the schema can hold
    // free text, so a smuggled token has nowhere to land.
    await expect(
      store.update((c) => ({ ...c, smuggled: "clankie_activity_producer_abc" }) as never),
    ).rejects.toThrow();
  });

  it("guards token-shaped values independently of the schema", () => {
    // Defence in depth for future fields that do accept free text: a settings
    // file is displayed unredacted, so a secret landing here would be disclosed
    // by the very affordance that makes settings useful.
    expect(() => assertNoSecretShapedValue({ any: "clankie_activity_producer_abc" })).toThrow(
      /secret_shaped_value/,
    );
    expect(() => assertNoSecretShapedValue({ any: "sk-abcdef" })).toThrow(/secret_shaped_value/);
    // Assembled at runtime rather than written as a literal: a hard-coded
    // Discord-shaped token trips secret scanners, which match the shape and
    // cannot know the value is fabricated.
    const tokenShaped = `${"A".repeat(24)}.${"B".repeat(6)}.${"C".repeat(27)}`;
    expect(() => assertNoSecretShapedValue({ token: tokenShaped })).toThrow(/secret_shaped_value/);
    // Public ids must stay storable.
    expect(() => assertNoSecretShapedValue({ id: "123456789012345678" })).not.toThrow();
  });

  it("honours CLANKIE_SETTINGS_FILE and otherwise sits beside credentials.json", () => {
    expect(defaultSettingsPath({ CLANKIE_SETTINGS_FILE: "/tmp/x.json" } as NodeJS.ProcessEnv)).toBe(
      "/tmp/x.json",
    );
    expect(defaultSettingsPath({ XDG_CONFIG_HOME: "/cfg" } as NodeJS.ProcessEnv)).toBe(
      "/cfg/clankie/settings.json",
    );
  });
});

describe("discord settings resolution", () => {
  const stored = DiscordSettingsSchema.parse({
    guildId: "111111111111111111",
    ingressChannelIds: ["222222222222222222"],
    textIngressEnabled: true,
  });

  it("lets the environment override stored values and reports every override", () => {
    const resolved = resolveDiscordSettings(stored, {
      DISCORD_GUILD_ID: "999999999999999999",
      DISCORD_INGRESS_CHANNEL_IDS: "333333333333333333,444444444444444444",
    } as NodeJS.ProcessEnv);

    expect(resolved.settings.guildId).toBe("999999999999999999");
    expect(resolved.settings.ingressChannelIds).toEqual(["333333333333333333", "444444444444444444"]);
    // A silent override is exactly what wastes an hour of debugging.
    expect(resolved.overriddenByEnvironment).toEqual(["DISCORD_GUILD_ID", "DISCORD_INGRESS_CHANNEL_IDS"]);
  });

  it("leaves stored values intact when the environment is empty", () => {
    const resolved = resolveDiscordSettings(stored, {} as NodeJS.ProcessEnv);
    expect(resolved.settings.guildId).toBe("111111111111111111");
    expect(resolved.overriddenByEnvironment).toEqual([]);
  });

  it("fills only unset environment names so a shell value still wins", () => {
    const env = { DISCORD_GUILD_ID: "999999999999999999" } as NodeJS.ProcessEnv;
    const applied = applyDiscordSettingsToEnvironment(stored, env);

    // The shell's explicit value is preserved...
    expect(env["DISCORD_GUILD_ID"]).toBe("999999999999999999");
    expect(applied).not.toContain("DISCORD_GUILD_ID");
    // ...while unset names are filled from the settings file.
    expect(env["DISCORD_INGRESS_CHANNEL_IDS"]).toBe("222222222222222222");
    expect(applied).toContain("DISCORD_INGRESS_CHANNEL_IDS");
  });

  it("projects back into the environment shape the bridge already reads", () => {
    const env = discordSettingsToEnvironment(stored);
    expect(env["DISCORD_GUILD_ID"]).toBe("111111111111111111");
    expect(env["DISCORD_INGRESS_CHANNEL_IDS"]).toBe("222222222222222222");
    expect(env["DISCORD_TEXT_INGRESS_ENABLED"]).toBe("true");
    // Disabled flags are omitted rather than set to "false", so a stale export
    // cannot accidentally enable a plane.
    expect(env["DISCORD_VOICE_ENABLED"]).toBeUndefined();
    expect(env["CLANKIE_POSSESSOR_VOICE_ENABLED"]).toBeUndefined();
  });

  it("carries the possessor voice seam flag so a bridge restart cannot silently mute play", () => {
    // The env-only flag muted his playthroughs whenever the bridge restarted
    // from a shell without it. Stored, deny-by-default, env still wins.
    const enabled = DiscordSettingsSchema.parse({ possessorVoiceEnabled: true });
    expect(discordSettingsToEnvironment(enabled)["CLANKIE_POSSESSOR_VOICE_ENABLED"]).toBe("true");

    const filled = {} as NodeJS.ProcessEnv;
    expect(applyDiscordSettingsToEnvironment(enabled, filled)).toContain("CLANKIE_POSSESSOR_VOICE_ENABLED");
    expect(filled["CLANKIE_POSSESSOR_VOICE_ENABLED"]).toBe("true");

    const overridden = resolveDiscordSettings(enabled, {
      CLANKIE_POSSESSOR_VOICE_ENABLED: "false",
    } as NodeJS.ProcessEnv);
    expect(overridden.settings.possessorVoiceEnabled).toBe(false);
    expect(overridden.overriddenByEnvironment).toContain("CLANKIE_POSSESSOR_VOICE_ENABLED");
  });

  it("carries the Discord system-actor allowlist and lets the environment override it", () => {
    expect(DiscordSettingsSchema.parse({}).systemActorUserIds).toEqual([]);
    expect(discordSettingsToEnvironment(stored)["DISCORD_SYSTEM_ACTOR_USER_IDS"]).toBeUndefined();

    const allowlisted = DiscordSettingsSchema.parse({
      systemActorUserIds: ["555555555555555555"],
    });
    expect(discordSettingsToEnvironment(allowlisted)["DISCORD_SYSTEM_ACTOR_USER_IDS"]).toBe(
      "555555555555555555",
    );

    const overridden = resolveDiscordSettings(allowlisted, {
      DISCORD_SYSTEM_ACTOR_USER_IDS: "111111111111111111,222222222222222222",
    } as NodeJS.ProcessEnv);
    expect(overridden.settings.systemActorUserIds).toEqual(["111111111111111111", "222222222222222222"]);
    expect(overridden.overriddenByEnvironment).toContain("DISCORD_SYSTEM_ACTOR_USER_IDS");
  });

  it("defaults the active body to the official bot and can switch to the lab body", () => {
    expect(DiscordSettingsSchema.parse({}).activeBody).toBe("bot");
    expect(discordSettingsToEnvironment(stored)["DISCORD_ACTIVE_BODY"]).toBe("bot");

    const labMouth = DiscordSettingsSchema.parse({ activeBody: "user_session" });
    expect(discordSettingsToEnvironment(labMouth)["DISCORD_ACTIVE_BODY"]).toBe("user_session");

    const overridden = resolveDiscordSettings(stored, {
      DISCORD_ACTIVE_BODY: "user_session",
    } as NodeJS.ProcessEnv);
    expect(overridden.settings.activeBody).toBe("user_session");
    expect(overridden.overriddenByEnvironment).toContain("DISCORD_ACTIVE_BODY");
  });

  it("projects the lab user-session body only when the owner enables it", () => {
    expect(DiscordSettingsSchema.parse({}).userSessionEnabled).toBe(false);
    expect(discordSettingsToEnvironment(stored)["DISCORD_USER_SESSION_ENABLED"]).toBeUndefined();

    const lab = DiscordSettingsSchema.parse({
      userSessionEnabled: true,
      userSessionGuildIds: ["111111111111111111"],
      userSessionChannelIds: ["222222222222222222"],
      userSessionVoiceEnabled: true,
    });
    const env = discordSettingsToEnvironment(lab);
    expect(env["DISCORD_USER_SESSION_ENABLED"]).toBe("true");
    expect(env["DISCORD_USER_SESSION_GUILD_IDS"]).toBe("111111111111111111");
    expect(env["DISCORD_USER_SESSION_CHANNEL_IDS"]).toBe("222222222222222222");
    expect(env["DISCORD_USER_SESSION_VOICE_ENABLED"]).toBe("true");
    expect(env["DISCORD_USER_SESSION_DM_POLICY"]).toBe("owner_only");

    const overridden = resolveDiscordSettings(lab, {
      DISCORD_USER_SESSION_ENABLED: "false",
    } as NodeJS.ProcessEnv);
    expect(overridden.settings.userSessionEnabled).toBe(false);
    expect(overridden.overriddenByEnvironment).toContain("DISCORD_USER_SESSION_ENABLED");
  });

  it("carries the voice consent policy, defaulting to explicit opt-in", () => {
    // Presence-as-consent is an owner decision (ADR 0045's boundary made
    // configurable); the default preserves the explicit policy exactly.
    expect(discordSettingsToEnvironment(stored)["DISCORD_VOICE_CONSENT_POLICY"]).toBe("explicit");
    const roomConsents = DiscordSettingsSchema.parse({ voiceConsentPolicy: "presence" });
    expect(discordSettingsToEnvironment(roomConsents)["DISCORD_VOICE_CONSENT_POLICY"]).toBe("presence");
    const overridden = resolveDiscordSettings(roomConsents, {
      DISCORD_VOICE_CONSENT_POLICY: "explicit",
    } as NodeJS.ProcessEnv);
    expect(overridden.settings.voiceConsentPolicy).toBe("explicit");
  });
});

describe("voice settings resolution", () => {
  it("defaults to the OpenAI realtime voice and projects nothing", () => {
    const settings = VoiceSettingsSchema.parse({});
    expect(settings.realtimeProvider).toBe("openai");
    expect(settings.ttsProvider).toBe("openai");
    // Nothing to project: the runtime's own defaults apply, and the default
    // provider is omitted exactly like a disabled flag.
    expect(voiceSettingsToEnvironment(settings)).toEqual({});
  });

  it("requires an ElevenLabs voice id before the provider can be elevenlabs", () => {
    expect(() => VoiceSettingsSchema.parse({ ttsProvider: "elevenlabs" })).toThrow(/elevenLabsVoiceId/);
    expect(() => VoiceSettingsSchema.parse({ elevenLabsVoiceId: "not a safe id!" })).toThrow();
  });

  it("projects the ElevenLabs configuration only under its provider", () => {
    const elevenLabs = VoiceSettingsSchema.parse({
      ttsProvider: "elevenlabs",
      elevenLabsVoiceId: "voice_abc123",
      elevenLabsModelId: "eleven_flash_v2_5",
      openAiVoice: "marin",
    });
    expect(voiceSettingsToEnvironment(elevenLabs)).toEqual({
      CLANKIE_VOICE_TTS_PROVIDER: "elevenlabs",
      CLANKIE_VOICE_ELEVENLABS_VOICE_ID: "voice_abc123",
      CLANKIE_VOICE_ELEVENLABS_MODEL_ID: "eleven_flash_v2_5",
      CLANKIE_VOICE_REALTIME_VOICE: "marin",
    });

    // Stored ElevenLabs ids with the openai provider are inactive
    // configuration, and the projection must not manufacture the env parser's
    // set-but-ignored failure from them.
    const inactive = VoiceSettingsSchema.parse({
      ttsProvider: "openai",
      openAiVoice: "cedar",
      elevenLabsVoiceId: "voice_abc123",
    });
    expect(voiceSettingsToEnvironment(inactive)).toEqual({ CLANKIE_VOICE_REALTIME_VOICE: "cedar" });
  });

  it("projects Grok Voice provider, model, voice, and reasoning without an invented STT model", () => {
    const grok = VoiceSettingsSchema.parse({
      realtimeProvider: "xai",
      xAiRealtimeModel: "grok-voice-think-fast-2.0",
      xAiVoice: "eve",
      xAiReasoningEffort: "none",
    });
    expect(voiceSettingsToEnvironment(grok)).toEqual({
      CLANKIE_VOICE_REALTIME_PROVIDER: "xai",
      CLANKIE_VOICE_REALTIME_MODEL: "grok-voice-think-fast-2.0",
      CLANKIE_VOICE_REALTIME_VOICE: "eve",
      CLANKIE_VOICE_XAI_REASONING_EFFORT: "none",
    });
    expect(() =>
      VoiceSettingsSchema.parse({
        realtimeProvider: "xai",
        ttsProvider: "elevenlabs",
        elevenLabsVoiceId: "voice_abc123",
      }),
    ).toThrow(/requires realtimeProvider openai/u);
  });

  it("fills only unset names and lets the environment win on read", () => {
    const settings = VoiceSettingsSchema.parse({
      ttsProvider: "elevenlabs",
      elevenLabsVoiceId: "voice_abc123",
    });
    const env = { CLANKIE_VOICE_ELEVENLABS_VOICE_ID: "voice_from_shell" } as NodeJS.ProcessEnv;
    const applied = applyVoiceSettingsToEnvironment(settings, env);
    expect(env["CLANKIE_VOICE_ELEVENLABS_VOICE_ID"]).toBe("voice_from_shell");
    expect(applied).toEqual(["CLANKIE_VOICE_TTS_PROVIDER"]);

    const resolved = resolveVoiceSettings(settings, {
      CLANKIE_VOICE_ELEVENLABS_VOICE_ID: "voice_from_shell",
    } as NodeJS.ProcessEnv);
    expect(resolved.settings.elevenLabsVoiceId).toBe("voice_from_shell");
    expect(resolved.overriddenByEnvironment).toEqual(["CLANKIE_VOICE_ELEVENLABS_VOICE_ID"]);
  });

  it("projects the selected provider when the environment switches providers", () => {
    const settings = VoiceSettingsSchema.parse({
      openAiRealtimeModel: "gpt-realtime-custom",
      openAiVoice: "cedar",
      xAiRealtimeModel: "grok-voice-custom",
      xAiVoice: "eve",
      xAiReasoningEffort: "none",
    });
    const env = { CLANKIE_VOICE_REALTIME_PROVIDER: "xai" } as NodeJS.ProcessEnv;

    expect(applyVoiceSettingsToEnvironment(settings, env)).toEqual([
      "CLANKIE_VOICE_REALTIME_MODEL",
      "CLANKIE_VOICE_REALTIME_VOICE",
      "CLANKIE_VOICE_XAI_REASONING_EFFORT",
    ]);
    expect(env["CLANKIE_VOICE_REALTIME_MODEL"]).toBe("grok-voice-custom");
    expect(env["CLANKIE_VOICE_REALTIME_VOICE"]).toBe("eve");
  });
});

describe("mcp and email settings", () => {
  it("closes the lane by default and requires the field the transport needs", () => {
    // Deny-by-default: a server the owner did not place in a room stays at the
    // console, so forgetting `lane` never widens who can reach it.
    expect(McpServerSchema.parse({ id: "notes", command: "notes-mcp" }).lane).toBe("operator");
    expect(() => McpServerSchema.parse({ id: "notes", transport: "stdio" })).toThrow(/command/);
    expect(() => McpServerSchema.parse({ id: "notes", transport: "http" })).toThrow(/url/);
  });

  it("refuses to send a bearer over plaintext off the machine", () => {
    const http = { id: "remote", transport: "http" as const };
    expect(() => McpServerSchema.parse({ ...http, url: "http://example.com/mcp" })).toThrow(/https/);
    expect(McpServerSchema.parse({ ...http, url: "http://127.0.0.1:8080/mcp" }).url).toContain("127.0.0.1");
    expect(McpServerSchema.parse({ ...http, url: "https://example.com/mcp" }).url).toContain("https");
  });

  it("opens a file written before linear was retired, and still rejects a typo", async () => {
    // A section this version dropped must not lock the owner out of his own
    // settings; anything else unknown is still a loud failure.
    const path = join(await mkdtemp(join(tmpdir(), "clankie-settings-")), "settings.json");
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: 1,
        linear: { defaultTeamId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
      })}\n`,
      "utf8",
    );
    expect((await new SettingsStore(path).load()).mcp.servers).toEqual([]);

    await writeFile(path, `${JSON.stringify({ schemaVersion: 1, lienar: {} })}\n`, "utf8");
    await expect(new SettingsStore(path).load()).rejects.toThrow(/nrecognized/);
  });

  it("defaults mail ports and refuses a credential-shaped hostname", () => {
    const parsed = EmailSettingsSchema.parse({});
    expect(parsed.imapPort).toBe(993);
    expect(parsed.smtpPort).toBe(587);
    expect(parsed.secure).toBe(true);
    expect(() => EmailSettingsSchema.parse({ imapHost: "user:pass@mail.example" })).toThrow(/hostname/);
  });

  it("loads a pre-connection settings file without the new keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clankie-settings-"));
    const path = join(directory, "settings.json");
    await writeFile(
      path,
      `${JSON.stringify({
        schemaVersion: 1,
        discord: DiscordSettingsSchema.parse({}),
        persona: { displayName: "Clankie" },
        voice: {},
      })}\n`,
      "utf8",
    );
    const loaded = await new SettingsStore(path).load();
    expect(loaded.mcp.servers).toEqual([]);
    expect(loaded.email.imapPort).toBe(993);
    expect(loaded.email.username).toBeUndefined();
  });
});
