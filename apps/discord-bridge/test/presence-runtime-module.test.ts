import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("presence runtime credential loading", () => {
  it("hard-errors on Discord user credentials", async () => {
    process.env.DISCORD_USER_TOKEN = "forbidden-user-token";
    delete process.env.DISCORD_BOT_TOKEN;
    const { createDiscordPresenceRuntime } = await import("../src/presence-runtime-module.ts");
    expect(() => createDiscordPresenceRuntime()).toThrow(/DISCORD_USER_TOKEN must not be set/);
  });

  it("hard-errors instead of accepting the legacy bot-token env", async () => {
    delete process.env.DISCORD_USER_TOKEN;
    process.env.DISCORD_BOT_TOKEN = "legacy-env-token";
    const { createDiscordPresenceRuntime } = await import("../src/presence-runtime-module.ts");
    expect(() => createDiscordPresenceRuntime()).toThrow(/credential broker/);
  });

  it("loads discord_bot only through the mode-0600 broker file", async () => {
    delete process.env.DISCORD_USER_TOKEN;
    delete process.env.DISCORD_BOT_TOKEN;
    const directory = await mkdtemp(join(tmpdir(), "discord-presence-broker-"));
    const path = join(directory, "credentials.json");
    await new FileCredentialStore(path).set("discord_bot", { type: "api", key: "broker-only-token" });
    process.env.CLANKIE_CREDENTIALS_FILE = path;
    process.env.DISCORD_PRESENCE_CHANNEL_IDS = "channel-1";
    const { createDiscordPresenceRuntime } = await import("../src/presence-runtime-module.ts");
    const runtime = createDiscordPresenceRuntime();
    await expect(
      runtime.execute({
        schemaVersion: 1,
        idempotencyKey: "write-1",
        action: "discord.presence.send_message",
        identity: {
          missionId: "mission-1",
          correlationId: "corr-1",
          profileHash: "profile-1",
          characterId: "character-1",
          credentialRef: "discord_bot",
          transportKind: "bot",
        },
        payload: { kind: "send_message", channelId: "channel-not-allowed", content: "hi" },
      }),
    ).rejects.toThrow(/channel_not_allowed/);
  });
});
