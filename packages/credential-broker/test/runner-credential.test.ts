import {
  RUNNER_CREDENTIAL_PROVIDER_ID,
  RunnerCredentialError,
  ensureRunnerCredential,
  mintRunnerToken,
  resolveRunnerCredential,
  type CredentialStore,
  type ProviderCredential,
} from "../src/index.ts";
import { describe, expect, it } from "vitest";

class MemoryCredentialStore implements CredentialStore {
  public readonly credentials = new Map<string, ProviderCredential>();
  public failWrites = false;

  public get(providerId: string): Promise<ProviderCredential | undefined> {
    return Promise.resolve(this.credentials.get(providerId));
  }

  public set(providerId: string, credential: ProviderCredential): Promise<void> {
    if (this.failWrites) return Promise.reject(new Error("store write refused"));
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

describe("runner credential", () => {
  it("mints and persists one stable local bearer the runner can then resolve", async () => {
    const store = new MemoryCredentialStore();
    const entropy = (size: number): Buffer => Buffer.alloc(size, 7);

    const first = await ensureRunnerCredential({ store, randomBytes: entropy });
    const second = await ensureRunnerCredential({ store });
    expect(second).toBe(first);
    expect(first.startsWith("clankie_runner_")).toBe(true);

    // The runner side is resolve-only and reads exactly what was minted.
    await expect(resolveRunnerCredential({ store })).resolves.toBe(first);
    expect(store.credentials.get(RUNNER_CREDENTIAL_PROVIDER_ID)).toEqual({ type: "api", key: first });
  });

  it("resolves to undefined before the control plane has minted", async () => {
    await expect(resolveRunnerCredential({ store: new MemoryCredentialStore() })).resolves.toBeUndefined();
  });

  it("refuses a malformed stored credential instead of authenticating with it", async () => {
    const store = new MemoryCredentialStore();
    store.credentials.set(RUNNER_CREDENTIAL_PROVIDER_ID, { type: "api", key: "not-a-runner-token" });
    await expect(resolveRunnerCredential({ store })).rejects.toMatchObject({
      name: "RunnerCredentialError",
      code: "invalid_stored_credential",
    });
  });

  it("fails loudly when the store cannot persist the bootstrap", async () => {
    const store = new MemoryCredentialStore();
    store.failWrites = true;
    await expect(ensureRunnerCredential({ store })).rejects.toBeInstanceOf(RunnerCredentialError);
  });

  it("mints distinct tokens from distinct entropy", () => {
    const a = mintRunnerToken((size) => Buffer.alloc(size, 1));
    const b = mintRunnerToken((size) => Buffer.alloc(size, 2));
    expect(a).not.toBe(b);
  });
});
