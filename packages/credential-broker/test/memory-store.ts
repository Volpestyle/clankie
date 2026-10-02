import type { CredentialStore, ProviderCredential } from "../src/credential-store.ts";

/** Lookup/write fixture only; listing and redaction belong to the real store tests. */
export class MemoryCredentialStore implements CredentialStore {
  public readonly credentials: Map<string, ProviderCredential>;

  public constructor(initial: Readonly<Record<string, ProviderCredential>> = {}) {
    this.credentials = new Map(Object.entries(initial));
  }

  public async get(id: string): Promise<ProviderCredential | undefined> {
    return this.credentials.get(id);
  }

  public async set(id: string, credential: ProviderCredential): Promise<void> {
    this.credentials.set(id, credential);
  }

  public async delete(id: string): Promise<boolean> {
    return this.credentials.delete(id);
  }

  public async list(): Promise<Record<string, never>> {
    throw new Error("Use a real credential store to exercise listing and redaction");
  }
}
