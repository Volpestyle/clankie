import { expect, it } from "vitest";
import {
  MinecraftSettingsSchema,
  MinecraftPlaySettingsSchema,
  SettingsStore,
  emptySettings,
} from "../src/index.ts";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const profile = { id: "paper", name: "Local Paper", host: "localhost", version: "1.21.4" };

it("defaults Minecraft off with no approved destinations and explicit offline profiles", () => {
  expect(emptySettings().minecraft).toEqual({
    profiles: [],
    publicAllowlist: [],
    play: MinecraftPlaySettingsSchema.parse({}),
  });
  expect(MinecraftSettingsSchema.parse({ profiles: [profile] }).profiles[0]).toEqual({
    ...profile,
    port: 25_565,
    username: "Clankie",
    auth: "offline",
  });
});

it("loads legacy Minecraft settings with bounded default play and persists owner overrides", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minecraft-play-settings-"));
  try {
    const path = join(dir, "settings.json");
    await writeFile(path, JSON.stringify({ schemaVersion: 1, minecraft: { profiles: [profile] } }));
    const store = new SettingsStore(path);
    const original = (await store.load()).minecraft;
    expect(original.play).toEqual({
      enabled: true,
      model: "openai/gpt-4.1-mini",
      maxTokens: 100_000,
      maxCostUsd: 1,
      turnIntervalMs: 2_000,
      idleBackoffMs: 15_000,
      idleStopMs: 900_000,
    });
    await store.update((current) => ({
      ...current,
      minecraft: {
        ...current.minecraft,
        play: { ...current.minecraft.play, enabled: false, maxCostUsd: 0.25, model: "xai/grok-4.3" },
      },
    }));
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.minecraft.play).toMatchObject({ enabled: false, maxCostUsd: 0.25, model: "xai/grok-4.3" });
    expect((await new SettingsStore(path).load()).minecraft.profiles).toEqual(original.profiles);
    await expect(
      store.update((current) => ({
        ...current,
        minecraft: { ...current.minecraft, play: { ...current.minecraft.play, maxTokens: 0 } },
      })),
    ).rejects.toThrow();
    expect((await store.load()).minecraft.play.maxTokens).toBe(100_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects credentials, endpoint syntax, online auth and ambiguous profile ids", () => {
  for (const host of [
    "https://world.example",
    "user@world.example",
    "world.example/path",
    "*.example",
    "[::1]",
    "fe80::1%en0",
  ])
    expect(MinecraftSettingsSchema.safeParse({ profiles: [{ ...profile, host }] }).success).toBe(false);
  for (const extra of [
    { token: "secret" },
    { auth: "microsoft" },
    { username: "name too long or spaced" },
    { port: 0 },
  ])
    expect(MinecraftSettingsSchema.safeParse({ profiles: [{ ...profile, ...extra }] }).success).toBe(false);
  expect(MinecraftSettingsSchema.safeParse({ profiles: [profile, profile] }).success).toBe(false);
});

it("normalizes approved host identities without accepting URLs or broad allowlists", () => {
  expect(
    MinecraftSettingsSchema.parse({ publicAllowlist: [{ host: "World.Example." }] }).publicAllowlist,
  ).toEqual([{ host: "world.example", port: 25_565 }]);
  expect(MinecraftSettingsSchema.safeParse({ publicAllowlist: [{ host: "*" }] }).success).toBe(false);
});
