import { expect, it } from "vitest";
import { MinecraftCommandSchema, DiscordActivitySurfaceSchema } from "../src/index.ts";

it("allows only profile references and typed actions at the command boundary", () => {
  expect(MinecraftCommandSchema.parse({ action: "join", profileId: "paper" })).toEqual({
    action: "join",
    profileId: "paper",
  });
  for (const extra of [
    { host: "world.example" },
    { port: 25565 },
    { auth: "offline" },
    { username: "Other" },
  ])
    expect(MinecraftCommandSchema.safeParse({ action: "join", profileId: "paper", ...extra }).success).toBe(
      false,
    );
  expect(MinecraftCommandSchema.parse({ action: "cancel" })).toEqual({ action: "cancel" });
  expect(
    MinecraftCommandSchema.safeParse({
      action: "act",
      request: { type: "follow", player: "James", distance: 0 },
    }).success,
  ).toBe(false);
  expect(DiscordActivitySurfaceSchema.parse("minecraft")).toBe("minecraft");
});
