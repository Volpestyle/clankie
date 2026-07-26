import { describe, expect, it } from "vitest";
import {
  CAPTAIN_CREDENTIAL_PROVIDER_ID,
  CaptainCredentialError,
  ensureCaptainCredential,
  mintCaptainToken,
  resolveCaptainCredential,
  type CredentialStore,
  type ProviderCredential,
  type RedactedCredential,
} from "../src/index.ts";

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

  public list(): Promise<Record<string, RedactedCredential>> {
    return Promise.resolve({});
  }
}

const entropy = (size: number): Buffer => Buffer.alloc(size, 0x33);

describe("captain credential lifecycle", () => {
  it("mints and persists on first run, then reuses the same token", async () => {
    const store = new MemoryCredentialStore();

    const first = await ensureCaptainCredential({ env: {}, store, randomBytes: entropy });
    const second = await ensureCaptainCredential({ env: {}, store, randomBytes: entropy });

    expect(first.source).toBe("store");
    expect(first.token).toMatch(/^clankie_cap_[A-Za-z0-9_-]{43}$/u);
    // Stability is the whole point: the control plane authenticates what
    // captain-eve presents, so a token that changed per call would authenticate
    // nothing.
    expect(second.token).toBe(first.token);
    expect(store.credentials.get(CAPTAIN_CREDENTIAL_PROVIDER_ID)).toBeDefined();
  });

  it("mints 256 bits rather than something guessable", async () => {
    const token = mintCaptainToken();
    expect(token).toMatch(/^clankie_cap_[A-Za-z0-9_-]{43}$/u);
    expect(mintCaptainToken()).not.toBe(token);
  });

  it("lets the environment override the store without writing to it", async () => {
    const store = new MemoryCredentialStore();

    const resolved = await ensureCaptainCredential({
      env: { CLANKIE_CAPTAIN_TOKEN: "operator-supplied" },
      store,
    });

    expect(resolved).toEqual({ token: "operator-supplied", source: "env" });
    expect(store.credentials.size).toBe(0);
  });

  it("reads nothing when nothing exists, rather than minting", async () => {
    await expect(
      resolveCaptainCredential({ env: {}, store: new MemoryCredentialStore() }),
    ).resolves.toBeUndefined();
  });

  it("refuses an empty environment override instead of authenticating as nobody", async () => {
    await expect(
      resolveCaptainCredential({ env: { CLANKIE_CAPTAIN_TOKEN: "" }, store: new MemoryCredentialStore() }),
    ).rejects.toThrow(CaptainCredentialError);
  });

  it("refuses a stored credential that does not look like a captain token", async () => {
    const store = new MemoryCredentialStore();
    await store.set(CAPTAIN_CREDENTIAL_PROVIDER_ID, { type: "api", key: "not-a-captain-token" });

    await expect(resolveCaptainCredential({ env: {}, store })).rejects.toThrow(/refusing to use it/u);
  });

  it("does not collide with the operator credential's slot", async () => {
    const store = new MemoryCredentialStore();
    await ensureCaptainCredential({ env: {}, store, randomBytes: entropy });

    expect([...store.credentials.keys()]).toEqual([CAPTAIN_CREDENTIAL_PROVIDER_ID]);
    expect(CAPTAIN_CREDENTIAL_PROVIDER_ID).not.toBe("clankie_operator");
  });
});
