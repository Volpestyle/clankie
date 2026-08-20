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
