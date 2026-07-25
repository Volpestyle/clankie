import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DiscordSettingsSchema,
  applyDiscordSettingsToEnvironment,
  SettingsStore,
  assertNoSecretShapedValue,
  defaultSettingsPath,
  discordSettingsToEnvironment,
  emptySettings,
  resolveDiscordSettings,
} from "../src/index.ts";

async function tempStore(): Promise<SettingsStore> {
  const directory = await mkdtemp(join(tmpdir(), "clankie-settings-"));
  return new SettingsStore(join(directory, "settings.json"));
}

describe("settings store", () => {
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
  });
});
