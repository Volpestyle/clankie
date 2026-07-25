import {
  DISCORD_BRIDGE_CREDENTIAL_PROVIDER_ID,
  DISCORD_USER_BRIDGE_CREDENTIAL_PROVIDER_ID,
  DISCORD_USER_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID,
  DISCORD_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID,
  ensureDiscordBridgeCredential,
  ensureDiscordUserBridgeCredential,
  ensureDiscordUserVoiceBridgeCredential,
  ensureDiscordVoiceBridgeCredential,
  mintDiscordBridgeToken,
  mintDiscordUserBridgeToken,
  mintDiscordUserVoiceBridgeToken,
  mintDiscordVoiceBridgeToken,
  resolveDiscordBridgeCredential,
  resolveDiscordUserBridgeCredential,
  resolveDiscordUserVoiceBridgeCredential,
  resolveDiscordVoiceBridgeCredential,
  type CredentialStore,
  type ProviderCredential,
} from "../src/index.ts";
import { describe, expect, it } from "vitest";

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

describe("Discord bridge credential", () => {
  it("mints and persists one stable 256-bit local bearer", async () => {
    const store = new MemoryCredentialStore();
    const entropy = (size: number): Buffer => Buffer.alloc(size, 7);

    const first = await ensureDiscordBridgeCredential({ store, randomBytes: entropy });
    const second = await ensureDiscordBridgeCredential({
      store,
      randomBytes: () => Buffer.alloc(32, 8),
    });

    expect(first).toBe(mintDiscordBridgeToken(entropy));
    expect(second).toBe(first);
    expect(await resolveDiscordBridgeCredential({ store })).toBe(first);
    expect(store.credentials.get(DISCORD_BRIDGE_CREDENTIAL_PROVIDER_ID)).toEqual({
      type: "api",
      key: first,
    });
  });

  it("refuses malformed stored bridge credentials", async () => {
    const store = new MemoryCredentialStore();
    store.credentials.set(DISCORD_BRIDGE_CREDENTIAL_PROVIDER_ID, {
      type: "api",
      key: "not-a-valid-bridge-token",
    });

    await expect(resolveDiscordBridgeCredential({ store })).rejects.toThrow(
      "stored Discord bridge credential is invalid",
    );
  });

  it("keeps voice authority on a distinct stable bearer", async () => {
    const store = new MemoryCredentialStore();
    const entropy = (size: number): Buffer => Buffer.alloc(size, 9);
    const voice = await ensureDiscordVoiceBridgeCredential({ store, randomBytes: entropy });
    const text = await ensureDiscordBridgeCredential({ store, randomBytes: entropy });

    expect(voice).toBe(mintDiscordVoiceBridgeToken(entropy));
    expect(voice).not.toBe(text);
    expect(await resolveDiscordVoiceBridgeCredential({ store })).toBe(voice);
    expect(store.credentials.get(DISCORD_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID)).toEqual({
      type: "api",
      key: voice,
    });
  });

  it("mints four mutually distinct plane bearers", async () => {
    const store = new MemoryCredentialStore();
    const entropy = (size: number): Buffer => Buffer.alloc(size, 7);
    const bearers = [
      await ensureDiscordBridgeCredential({ store, randomBytes: entropy }),
      await ensureDiscordVoiceBridgeCredential({ store, randomBytes: entropy }),
      await ensureDiscordUserBridgeCredential({ store, randomBytes: entropy }),
      await ensureDiscordUserVoiceBridgeCredential({ store, randomBytes: entropy }),
    ];

    expect(new Set(bearers).size).toBe(4);
    expect(bearers[2]).toBe(mintDiscordUserBridgeToken(entropy));
    expect(bearers[3]).toBe(mintDiscordUserVoiceBridgeToken(entropy));
    expect(await resolveDiscordUserBridgeCredential({ store })).toBe(bearers[2]);
    expect(await resolveDiscordUserVoiceBridgeCredential({ store })).toBe(bearers[3]);
    expect(store.credentials.get(DISCORD_USER_BRIDGE_CREDENTIAL_PROVIDER_ID)).toEqual({
      type: "api",
      key: bearers[2],
    });
    expect(store.credentials.get(DISCORD_USER_VOICE_BRIDGE_CREDENTIAL_PROVIDER_ID)).toEqual({
      type: "api",
      key: bearers[3],
    });
  });

  it("refuses a user-plane bearer stored under a bot-plane provider", async () => {
    // `clankie_discord_` prefixes every bearer, so without anchored patterns a
    // user-session token filed as the bot bearer would authenticate as the bot
    // bridge and silently inherit its transport entitlement.
    const store = new MemoryCredentialStore();
    const userBearer = mintDiscordUserBridgeToken((size) => Buffer.alloc(size, 3));
    store.credentials.set(DISCORD_BRIDGE_CREDENTIAL_PROVIDER_ID, { type: "api", key: userBearer });

    await expect(resolveDiscordBridgeCredential({ store })).rejects.toThrow(
      "stored Discord bridge credential is invalid",
    );

    const voiceBearer = mintDiscordUserVoiceBridgeToken((size) => Buffer.alloc(size, 4));
    store.credentials.set(DISCORD_USER_BRIDGE_CREDENTIAL_PROVIDER_ID, { type: "api", key: voiceBearer });
    await expect(resolveDiscordUserBridgeCredential({ store })).rejects.toThrow(
      "stored Discord user-session bridge credential is invalid",
    );
  });
});
