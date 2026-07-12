import { describe, expect, it } from "vitest";
import {
  CapabilityTokenIssuer,
  DiscordBotCredentialProvider,
  redactCredential,
  type CredentialStore,
  type ProviderCredential,
  type RedactedCredential,
} from "../src/index.ts";

class MemoryStore implements CredentialStore {
  private readonly credential: ProviderCredential | undefined;
  public constructor(credential: ProviderCredential | undefined) { this.credential = credential; }
  public async get(): Promise<ProviderCredential | undefined> { return this.credential; }
  public async set(): Promise<void> { throw new Error("not implemented"); }
  public async delete(): Promise<boolean> { return false; }
  public async list(): Promise<Record<string, RedactedCredential>> {
    return this.credential === undefined ? {} : { discord_bot: redactCredential(this.credential) };
  }
}

describe("DiscordBotCredentialProvider", () => {
  it("issues expiring mission grants scoped to configured guilds and channels", async () => {
    let now = 100;
    const provider = new DiscordBotCredentialProvider({
      store: new MemoryStore({ type: "api", key: "discord-secret-token" }),
      allowedGuildIds: ["guild-1"],
      allowedChannelIds: ["channel-1"],
      issuer: new CapabilityTokenIssuer(Buffer.alloc(32, 5)),
      now: () => now,
    });
    const request = {
      principalId: "character-1", missionId: "mission-1", profileHash: "profile-1",
      capability: "discord.presence.act" as const, guildIds: ["guild-1"], channelIds: ["channel-1"],
      ttlSeconds: 30,
    };
    const grant = await provider.issueGrant(request);
    expect(await provider.resolveBotToken({ grant, ...request })).toBe("discord-secret-token");
    await expect(provider.resolveBotToken({ grant, ...request, channelIds: ["channel-2"] }))
      .rejects.toThrow(/channel_not_allowed/);
    await expect(provider.resolveBotToken({ grant, ...request, missionId: "mission-2" }))
      .rejects.toThrow(/grant_scope_denied/);
    now = 130;
    await expect(provider.resolveBotToken({ grant, ...request })).rejects.toThrow(/expired/);
  });

  it("fails closed for unconfigured resources and missing broker credentials", async () => {
    const missing = new DiscordBotCredentialProvider({
      store: new MemoryStore(undefined), allowedGuildIds: [], allowedChannelIds: [],
    });
    await expect(missing.issueGrant({
      principalId: "p", missionId: "m", profileHash: "h", capability: "discord.presence.read",
      channelIds: ["not-allowed"],
    })).rejects.toThrow(/channel_not_allowed/);
    const configured = new DiscordBotCredentialProvider({
      store: new MemoryStore(undefined), allowedGuildIds: [], allowedChannelIds: ["channel-1"],
    });
    await expect(configured.issueGrant({
      principalId: "p", missionId: "m", profileHash: "h", capability: "discord.presence.read",
      channelIds: ["channel-1"],
    })).rejects.toThrow(/No API credential stored for discord_bot/);
  });

  it("redacts the discord_bot provider from summaries and logs", async () => {
    const secret = "discord-secret-token-never-log";
    const listed = await new MemoryStore({ type: "api", key: secret }).list();
    expect(JSON.stringify(listed)).not.toContain(secret);
    expect(listed.discord_bot).toEqual({ type: "api", key: "disc…" });
  });
});
