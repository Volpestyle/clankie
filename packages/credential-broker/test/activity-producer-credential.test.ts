import { describe, expect, it } from "vitest";
import {
  ACTIVITY_PRODUCER_CREDENTIAL_PROVIDER_ID,
  ensureActivityProducerCredential,
  mintActivityProducerToken,
  resolveActivityProducerCredential,
} from "../src/activity-producer-credential.ts";
import type { CredentialStore } from "../src/credential-store.ts";

function memoryStore(): CredentialStore {
  const entries = new Map<string, { type: string; key: string }>();
  return {
    get: (id: string) => Promise.resolve(entries.get(id) as never),
    set: (id: string, credential: { type: string; key: string }) => {
      entries.set(id, credential);
      return Promise.resolve();
    },
    delete: (id: string) => {
      entries.delete(id);
      return Promise.resolve();
    },
    list: () => Promise.resolve([...entries.keys()]),
  } as unknown as CredentialStore;
}

describe("activity producer credential", () => {
  it("mints a prefixed, high-entropy bearer distinct from the Discord bridge family", () => {
    const token = mintActivityProducerToken();
    expect(token).toMatch(/^clankie_activity_producer_[A-Za-z0-9_-]{43}$/u);
    // Must not be mistakable for a Discord-plane bearer.
    expect(token.startsWith("clankie_discord_")).toBe(false);
    expect(mintActivityProducerToken()).not.toBe(token);
  });

  it("bootstraps once and resolves the same token afterwards", async () => {
    const store = memoryStore();
    const env = {} as NodeJS.ProcessEnv;
    const first = await ensureActivityProducerCredential({ store, env });
    const second = await ensureActivityProducerCredential({ store, env });
    expect(second).toBe(first);
    await expect(resolveActivityProducerCredential({ store, env })).resolves.toBe(first);
  });

  it("refuses a token supplied through the environment", async () => {
    const store = memoryStore();
    const env = { CLANKIE_ACTIVITY_PRODUCER_TOKEN: "clankie_activity_producer_x" } as NodeJS.ProcessEnv;
    // A process accepting both sources would silently prefer the weaker one.
    await expect(resolveActivityProducerCredential({ store, env })).rejects.toThrow(/must not be set/);
  });

  it("refuses a stored credential that does not match the pattern", async () => {
    const store = memoryStore();
    const env = {} as NodeJS.ProcessEnv;
    await store.set(ACTIVITY_PRODUCER_CREDENTIAL_PROVIDER_ID, { type: "api", key: "not-a-valid-token" });
    await expect(resolveActivityProducerCredential({ store, env })).rejects.toThrow(
      /invalid; refusing to use it/,
    );
  });

  it("returns undefined before bootstrap so callers can fail closed", async () => {
    await expect(
      resolveActivityProducerCredential({ store: memoryStore(), env: {} as NodeJS.ProcessEnv }),
    ).resolves.toBeUndefined();
  });
});
