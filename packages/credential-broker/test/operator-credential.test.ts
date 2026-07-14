import { describe, expect, it } from "vitest";
import {
  ensureOperatorCredential,
  inspectOperatorCredential,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
  OperatorCredentialError,
  resolveOperatorCredential,
  rotateOperatorCredential,
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

const firstEntropy = (size: number): Buffer => Buffer.alloc(size, 0x11);
const secondEntropy = (size: number): Buffer => Buffer.alloc(size, 0x22);

describe("operator credential lifecycle", () => {
  it("mints and persists a high-entropy first-run credential, then auto-loads it", async () => {
    const store = new MemoryCredentialStore();
    const minted = await ensureOperatorCredential({ env: {}, store, randomBytes: firstEntropy });

    expect(minted.source).toBe("store");
    expect(minted.token).toBe(mintOperatorToken(firstEntropy));
    expect(minted.token).toMatch(/^clankie_op_[A-Za-z0-9_-]{43}$/u);
    expect(store.credentials.get(OPERATOR_CREDENTIAL_PROVIDER_ID)).toEqual({
      type: "api",
      key: minted.token,
    });
    await expect(resolveOperatorCredential({ env: {}, store })).resolves.toEqual(minted);
  });

  it("uses the environment override and reports a mismatch without exposing either token", async () => {
    const store = new MemoryCredentialStore();
    const stored = mintOperatorToken(firstEntropy);
    const overridden = mintOperatorToken(secondEntropy);
    await store.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: stored });

    const resolved = await resolveOperatorCredential({
      env: { CLANKIE_OPERATOR_TOKEN: overridden },
      store,
    });
    const status = await inspectOperatorCredential({
      env: { CLANKIE_OPERATOR_TOKEN: overridden },
      store,
    });

    expect(resolved).toMatchObject({
      token: overridden,
      source: "env",
      status: { present: true, source: "env", consistency: "env_only" },
    });
    expect(status).toEqual({ present: true, source: "env", consistency: "mismatch" });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(stored);
    expect(serialized).not.toContain(overridden);
    expect(serialized).not.toContain("clankie_op_");
  });

  it("rotates the store in one write and makes the old credential unavailable", async () => {
    const store = new MemoryCredentialStore();
    const original = await ensureOperatorCredential({ env: {}, store, randomBytes: firstEntropy });
    const rotated = await rotateOperatorCredential({ env: {}, store, randomBytes: secondEntropy });

    expect(rotated.token).not.toBe(original.token);
    await expect(resolveOperatorCredential({ env: {}, store })).resolves.toEqual(rotated);
    expect(JSON.stringify(await inspectOperatorCredential({ env: {}, store }))).not.toContain(rotated.token);
  });

  it("fails closed for malformed credentials and refuses store rotation under an env override", async () => {
    const store = new MemoryCredentialStore();
    await store.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: "hand-minted-weak-token" });
    await expect(resolveOperatorCredential({ env: {}, store })).rejects.toMatchObject({
      code: "invalid_stored_credential",
    } satisfies Partial<OperatorCredentialError>);

    const override = mintOperatorToken(firstEntropy);
    await expect(
      rotateOperatorCredential({
        env: { CLANKIE_OPERATOR_TOKEN: override },
        store,
        randomBytes: secondEntropy,
      }),
    ).rejects.toMatchObject({
      code: "environment_override_active",
    } satisfies Partial<OperatorCredentialError>);
  });

  it("redacts a minted token even when the underlying store includes it in a write failure", async () => {
    let attemptedToken = "";
    const store: CredentialStore = {
      get: () => Promise.resolve(undefined),
      set: (_providerId, credential) => {
        attemptedToken = credential.type === "api" ? credential.key : "";
        return Promise.reject(new Error(`write failed for ${attemptedToken}`));
      },
      delete: () => Promise.resolve(false),
      list: () => Promise.resolve({}),
    };

    let failure: unknown;
    try {
      await ensureOperatorCredential({ env: {}, store, randomBytes: firstEntropy });
    } catch (error) {
      failure = error;
    }

    expect(attemptedToken).toMatch(/^clankie_op_/u);
    expect(String(failure)).not.toContain(attemptedToken);
    expect(failure).toMatchObject({ code: "store_unavailable" });
  });
});
