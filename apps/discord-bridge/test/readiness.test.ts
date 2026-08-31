import type { DiscordControlPlaneReadiness } from "@clankie/api-client";
import {
  DISCORD_BOT_PROVIDER_ID,
  DISCORD_BRIDGE_CREDENTIAL_PROVIDER_ID,
  mintDiscordBridgeToken,
  type CredentialStore,
  type ProviderCredential,
} from "@clankie/credential-broker";
import { ApplicationFlagsBitField, Routes } from "discord.js";
import { describe, expect, it } from "vitest";
import { inspectDiscordTextReadiness } from "../src/readiness.ts";

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

const readyControlPlane: DiscordControlPlaneReadiness = {
  schemaVersion: 1,
  ready: true,
  service: "clankie",
  instanceId: "control-plane-boot-1",
  profileHash: "profile",
  checks: {
    captainChannelTurns: true,
    discordPresenceRuntime: true,
  },
};

describe("Discord text readiness", () => {
  it("proves a complete official-bot composition without retaining identity names or secrets", async () => {
    const store = new MemoryCredentialStore();
    store.credentials.set(DISCORD_BOT_PROVIDER_ID, { type: "api", key: "bot-secret-marker" });
    store.credentials.set(DISCORD_BRIDGE_CREDENTIAL_PROVIDER_ID, {
      type: "api",
      key: mintDiscordBridgeToken(() => Buffer.alloc(32, 4)),
    });
    const env = {
      DISCORD_APPLICATION_ID: "111111111111111111",
      DISCORD_GUILD_ID: "222222222222222222",
      DISCORD_AMBIENT_ROLE_IDS: "333333333333333333",
      DISCORD_TEXT_INGRESS_ENABLED: "true",
      DISCORD_INGRESS_GUILD_IDS: "222222222222222222",
      DISCORD_INGRESS_CHANNEL_IDS: "444444444444444444",
      DISCORD_PRESENCE_GUILD_IDS: "222222222222222222",
      DISCORD_PRESENCE_CHANNEL_IDS: "444444444444444444",
      DISCORD_SWARM_GUILD_ID: "555555555555555555",
    };
    const report = await inspectDiscordTextReadiness({
      env,
      store,
      api: { inspectDiscordReadiness: () => Promise.resolve(readyControlPlane) },
      rest: {
        get: (route) =>
          Promise.resolve(
            route === Routes.currentApplication()
              ? {
                  id: env.DISCORD_APPLICATION_ID,
                  name: "private-name-must-not-appear",
                  flags: ApplicationFlagsBitField.Flags.GatewayMessageContent,
                }
              : route === `/guilds/${env.DISCORD_SWARM_GUILD_ID}/members/${env.DISCORD_APPLICATION_ID}`
                ? { roles: ["666666666666666666"] }
                : route === `/guilds/${env.DISCORD_SWARM_GUILD_ID}`
                  ? {
                      name: "private-guild-must-not-appear",
                      roles: [
                        { id: env.DISCORD_SWARM_GUILD_ID, permissions: "0" },
                        // Manage Channels, Manage Webhooks, and Send Messages.
                        {
                          id: "666666666666666666",
                          permissions: String((1n << 4n) | (1n << 29n) | (1n << 11n)),
                        },
                      ],
                    }
                  : { user: { username: "private-user-must-not-appear" } },
          ),
      },
      clock: () => new Date("2026-07-25T16:00:00.000Z"),
    });

    expect(report.ready).toBe(true);
    expect(report.checks.every((check) => check.ok)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("bot-secret-marker");
    expect(JSON.stringify(report)).not.toContain("private-name-must-not-appear");
    expect(JSON.stringify(report)).not.toContain("private-user-must-not-appear");
    expect(JSON.stringify(report)).not.toContain("private-guild-must-not-appear");
  });

  it("accepts either ambient binding, because the runtime authorizes on either", async () => {
    const matrix = [
      // [role ids, user ids, ready]
      ["333333333333333333", "", true],
      ["", "830574404453793842", true],
      ["333333333333333333", "830574404453793842", true],
      ["", "", false],
    ] as const;
    for (const [roles, users, ready] of matrix) {
      const report = await inspectDiscordTextReadiness({
        env: { DISCORD_AMBIENT_ROLE_IDS: roles, DISCORD_AMBIENT_USER_IDS: users },
        store: new MemoryCredentialStore(),
        api: { inspectDiscordReadiness: () => Promise.resolve(readyControlPlane) },
        clock: () => new Date("2026-07-25T16:00:00.000Z"),
      });
      const check = report.checks.find((entry) => entry.name === "ambient authority");
      expect({ roles, users, ok: check?.ok }).toEqual({ roles, users, ok: ready });
      // Counts, never the ids themselves.
      expect(check?.detail).not.toContain("830574404453793842");
      expect(check?.detail).not.toContain("333333333333333333");
    }
  });

  it("reads an empty channel allowlist as the whole guild, not as a gap", async () => {
    const matrix = [
      // [ingress channels, presence channels, ingress ok, presence ok]
      ["", "", true, true],
      ["444444444444444444", "444444444444444444", true, true],
      ["444444444444444444", "", true, true],
      // A restricted presence list cannot cover an ingress wildcard: channels
      // are admitted that have no way to answer.
      ["", "444444444444444444", true, false],
      ["444444444444444444,777777777777777777", "444444444444444444", true, false],
    ] as const;
    for (const [ingressChannels, presenceChannels, ingressOk, presenceOk] of matrix) {
      const report = await inspectDiscordTextReadiness({
        env: {
          DISCORD_GUILD_ID: "222222222222222222",
          DISCORD_INGRESS_GUILD_IDS: "222222222222222222",
          DISCORD_INGRESS_CHANNEL_IDS: ingressChannels,
          DISCORD_PRESENCE_GUILD_IDS: "222222222222222222",
          DISCORD_PRESENCE_CHANNEL_IDS: presenceChannels,
        },
        store: new MemoryCredentialStore(),
        api: { inspectDiscordReadiness: () => Promise.resolve(readyControlPlane) },
        clock: () => new Date("2026-07-25T16:00:00.000Z"),
      });
      const named = (name: string): boolean =>
        report.checks.find((check) => check.name === name)?.ok ?? false;
      expect({ ingressChannels, presenceChannels, ingress: named("ingress allowlist") }).toEqual({
        ingressChannels,
        presenceChannels,
        ingress: ingressOk,
      });
      expect({ ingressChannels, presenceChannels, presence: named("presence allowlist") }).toEqual({
        ingressChannels,
        presenceChannels,
        presence: presenceOk,
      });
    }
  });

  it("names the room-making permissions the swarm home is missing, and nothing else", async () => {
    const store = new MemoryCredentialStore();
    store.credentials.set(DISCORD_BOT_PROVIDER_ID, { type: "api", key: "bot-secret-marker" });
    const env = {
      DISCORD_APPLICATION_ID: "111111111111111111",
      DISCORD_GUILD_ID: "222222222222222222",
      DISCORD_SWARM_GUILD_ID: "555555555555555555",
    };
    const report = await inspectDiscordTextReadiness({
      env,
      store,
      api: { inspectDiscordReadiness: () => Promise.resolve(readyControlPlane) },
      rest: {
        get: (route) =>
          Promise.resolve(
            route === Routes.currentApplication()
              ? {
                  id: env.DISCORD_APPLICATION_ID,
                  flags: ApplicationFlagsBitField.Flags.GatewayMessageContent,
                }
              : route === `/guilds/${env.DISCORD_SWARM_GUILD_ID}/members/${env.DISCORD_APPLICATION_ID}`
                ? { roles: [] }
                : {
                    name: "private-guild-must-not-appear",
                    // Send Messages only: the text lane is healthy and rooms
                    // still cannot be made, which is the failure worth naming.
                    roles: [{ id: env.DISCORD_SWARM_GUILD_ID, permissions: String(1n << 11n) }],
                  },
          ),
      },
      clock: () => new Date("2026-07-25T16:00:00.000Z"),
    });

    const check = report.checks.find((entry) => entry.name === "swarm home permissions");
    expect(check).toMatchObject({
      ok: false,
      detail: "missing Manage Channels and Manage Webhooks in the swarm home",
    });
    expect(check?.remediation).toContain("/discord invite");
    // Guild-wide grants are not the whole answer, and the report says so.
    expect(check?.remediation).toContain("overwrites");
    expect(JSON.stringify(report)).not.toContain("bot-secret-marker");
    expect(JSON.stringify(report)).not.toContain("private-guild-must-not-appear");
  });

  it("treats Administrator as holding both room-making permissions", async () => {
    const store = new MemoryCredentialStore();
    store.credentials.set(DISCORD_BOT_PROVIDER_ID, { type: "api", key: "bot-secret-marker" });
    const env = {
      DISCORD_APPLICATION_ID: "111111111111111111",
      DISCORD_SWARM_GUILD_ID: "555555555555555555",
    };
    const report = await inspectDiscordTextReadiness({
      env,
      store,
      api: { inspectDiscordReadiness: () => Promise.resolve(readyControlPlane) },
      rest: {
        get: (route) =>
          Promise.resolve(
            route === Routes.currentApplication()
              ? {
                  id: env.DISCORD_APPLICATION_ID,
                  flags: ApplicationFlagsBitField.Flags.GatewayMessageContent,
                }
              : route === `/guilds/${env.DISCORD_SWARM_GUILD_ID}/members/${env.DISCORD_APPLICATION_ID}`
                ? { roles: [] }
                : { roles: [{ id: env.DISCORD_SWARM_GUILD_ID, permissions: String(1n << 3n) }] },
          ),
      },
      clock: () => new Date("2026-07-25T16:00:00.000Z"),
    });

    expect(report.checks.find((entry) => entry.name === "swarm home permissions")).toMatchObject({
      ok: true,
    });
  });

  it("returns an actionable fail-closed report when live prerequisites are absent", async () => {
    const report = await inspectDiscordTextReadiness({
      env: {},
      store: new MemoryCredentialStore(),
      api: {
        inspectDiscordReadiness: () => Promise.reject(new Error("clankie service unreachable")),
      },
      clock: () => new Date("2026-07-25T16:00:00.000Z"),
    });

    expect(report.ready).toBe(false);
    expect(report.checks.find((check) => check.name === "official bot credential")).toMatchObject({
      ok: false,
    });
    expect(report.checks.find((check) => check.name === "service composition")).toMatchObject({
      ok: false,
      detail: "clankie service unreachable",
    });
  });
});
