import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { DiscordPresenceSessionRecordSchema } from "@clankie/interactive-environment";

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
      runtime.execute(
        {
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
        },
        DiscordPresenceSessionRecordSchema.parse({
          schemaVersion: 1,
          sessionId: "discord:bot:fixture",
          characterId: "character-1",
          credentialRef: "discord_bot",
          transportKind: "bot",
          phase: "present",
          gatewayConnected: true,
          voiceGuildIds: [],
          revision: 1,
          updatedAt: "2026-07-14T18:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/channel_not_allowed/);
  });
});

/**
 * The provisioning half against a fake REST. The live probe can only prove the
 * listing until the bot holds Manage Webhooks in the home guild, so the calls
 * that write are proved here instead — including that an existing room is used
 * rather than a new one made, and that an id from outside the home guild is
 * refused before anything is created.
 */
describe("channel provisioning against the swarm home", () => {
  const GUILD_ROOMS = [
    { id: "42", name: "general", type: 0 },
    { id: "43", name: "fleet", type: 0 },
    { id: "44", name: "Voice", type: 2 },
  ];

  async function runtimeWithFakeRest(): Promise<{
    runtime: Awaited<ReturnType<typeof loadRuntime>>;
    calls: string[];
  }> {
    const directory = await mkdtemp(join(tmpdir(), "discord-provision-broker-"));
    const path = join(directory, "credentials.json");
    await new FileCredentialStore(path).set("discord_bot", { type: "api", key: "broker-only-token" });
    delete process.env.DISCORD_USER_TOKEN;
    delete process.env.DISCORD_BOT_TOKEN;
    process.env.CLANKIE_CREDENTIALS_FILE = path;
    // The command server and the presence allowlist name guilds that are NOT
    // the swarm home, and the swarm home appears on neither. Provisioning has
    // to work anyway: the two are separate authorities, so a swarm home that
    // only worked when it was also a presence guild would be the same field
    // wearing two names.
    process.env.DISCORD_GUILD_ID = "command-guild";
    process.env.DISCORD_SWARM_GUILD_ID = "guild-1";
    process.env.DISCORD_PRESENCE_GUILD_IDS = "inhabited-guild";
    delete process.env.DISCORD_PRESENCE_CHANNEL_IDS;
    const calls: string[] = [];
    const rest = {
      get: (route: string) => {
        calls.push(`GET ${route}`);
        return Promise.resolve(GUILD_ROOMS);
      },
      post: (route: string) => {
        calls.push(`POST ${route}`);
        return Promise.resolve(
          route.endsWith("/webhooks") ? { id: "webhook-1", token: "webhook-secret" } : { id: "new-channel" },
        );
      },
    };
    return { runtime: await loadRuntime(rest), calls };
  }

  async function loadRuntime(rest: unknown) {
    const { createDiscordPresenceRuntime } = await import("../src/presence-runtime-module.ts");
    return createDiscordPresenceRuntime({ rest: rest as never });
  }

  it("provisions only into the swarm home, never the command server or an inhabited guild", async () => {
    const { runtime } = await runtimeWithFakeRest();
    expect(runtime.swarmGuildId()).toBe("guild-1");
    // Every route it builds names the swarm home, though the command server and
    // an inhabited presence guild are both configured and one of them would
    // have answered before the swarm home existed as its own field.
    expect((await runtime.provisionChannel({ name: "Atlas slowness" })).guildId).toBe("guild-1");

    delete process.env.DISCORD_SWARM_GUILD_ID;
    const { createDiscordPresenceRuntime } = await import("../src/presence-runtime-module.ts");
    const unset = createDiscordPresenceRuntime({ rest: {} as never });
    // No swarm home is no room, rather than falling back to a guild he is only
    // a member of.
    await expect(unset.listRooms()).rejects.toThrow(/discord_swarm_guild_unset/);
    expect(unset.swarmGuildId()).toBeUndefined();
  });

  it("offers only the rooms a webhook can post into", async () => {
    const { runtime, calls } = await runtimeWithFakeRest();
    expect(await runtime.listRooms()).toEqual([
      { channelId: "43", name: "fleet" },
      { channelId: "42", name: "general" },
    ]);
    expect(calls).toEqual(["GET /guilds/guild-1/channels"]);
  });

  it("puts the webhook on a room the server already has, making no channel", async () => {
    const { runtime, calls } = await runtimeWithFakeRest();
    expect(await runtime.provisionChannel({ name: "Atlas slowness", channelId: "43" })).toEqual({
      guildId: "guild-1",
      channelId: "43",
      webhookId: "webhook-1",
      webhookToken: "webhook-secret",
    });
    // No POST to /guilds/…/channels: the room was already there.
    expect(calls).toEqual(["GET /guilds/guild-1/channels", "POST /channels/43/webhooks"]);
  });

  it("refuses a channel id from outside the swarm home before creating anything", async () => {
    const { runtime, calls } = await runtimeWithFakeRest();
    await expect(runtime.provisionChannel({ name: "Atlas slowness", channelId: "999" })).rejects.toThrow(
      /discord_channel_not_in_swarm_guild/,
    );
    // The guild-scoped grant would otherwise reach a room in a guild Clankie
    // only inhabits, which the swarm fence is supposed to be the whole of.
    expect(calls).toEqual(["GET /guilds/guild-1/channels"]);
  });

  it("makes the channel and its webhook when no existing room is named", async () => {
    const { runtime, calls } = await runtimeWithFakeRest();
    expect(await runtime.provisionChannel({ name: "Atlas slowness" })).toMatchObject({
      guildId: "guild-1",
      channelId: "new-channel",
      webhookId: "webhook-1",
    });
    expect(calls).toEqual(["POST /guilds/guild-1/channels", "POST /channels/new-channel/webhooks"]);
  });
});
