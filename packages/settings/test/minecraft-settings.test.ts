import { expect, it } from "vitest";
import { MinecraftSettingsSchema, emptySettings } from "../src/index.ts";

const profile = { id: "paper", name: "Local Paper", host: "localhost", version: "1.21.4" };

it("defaults Minecraft off with no approved destinations and explicit offline profiles", () => {
  expect(emptySettings().minecraft).toEqual({ profiles: [], publicAllowlist: [] });
  expect(MinecraftSettingsSchema.parse({ profiles: [profile] }).profiles[0]).toEqual({
    ...profile,
    port: 25_565,
    username: "Clankie",
    auth: "offline",
  });
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
