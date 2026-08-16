import {
  ensureOperatorCredential,
  rotateOperatorCredential,
  type CredentialStore,
  type ProviderCredential,
  type RedactedCredential,
} from "@clankie/credential-broker";
import { describe, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";

class MemoryCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, ProviderCredential>();

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

describe("credential-backed operator authentication", () => {
  it("bootstraps a fresh store and reaches the device list without an env token", async () => {
    const store = new MemoryCredentialStore();
    const credential = await ensureOperatorCredential({ env: {}, store });
    const { app } = await createClankieApp({
      captain: createStubCaptain(),
      authenticateOperator: createCredentialBackedOperatorAuthenticator({
        env: {},
        store,
        identity: { operatorId: "local-operator", steerSourceLane: "tui" },
      }),
    });

    const response = await app.request("/v1/devices", {
      headers: { authorization: `Bearer ${credential.token}` },
    });
    expect(response.status).toBe(200);
  });

  it("invalidates the old server and client credential immediately after one rotation", async () => {
    const store = new MemoryCredentialStore();
    const original = await ensureOperatorCredential({ env: {}, store });
    const authenticateOperator = createCredentialBackedOperatorAuthenticator({
      env: {},
      store,
      identity: { operatorId: "local-operator", steerSourceLane: "tui" },
    });
    const { app } = await createClankieApp({ captain: createStubCaptain(), authenticateOperator });
    const rotated = await rotateOperatorCredential({ env: {}, store });

    const oldResponse = await app.request("/v1/devices", {
      headers: { authorization: `Bearer ${original.token}` },
    });
    const newResponse = await app.request("/v1/devices", {
      headers: { authorization: `Bearer ${rotated.token}` },
    });
    expect(oldResponse.status).toBe(401);
    expect(newResponse.status).toBe(200);
  });
});
