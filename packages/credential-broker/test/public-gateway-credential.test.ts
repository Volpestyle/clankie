import { describe, expect, it } from "vitest";
import {
  PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID,
  resolvePublicGatewayCredential,
  type CredentialStore,
  type ProviderCredential,
} from "../src/index.ts";

describe("public gateway credential", () => {
  it("reads a valid bearer only from the broker", async () => {
    const values = new Map<string, ProviderCredential>();
    const memoryStore = {
      get: (id: string) => Promise.resolve(values.get(id)),
      set: (id: string, value: ProviderCredential) => {
        values.set(id, value);
        return Promise.resolve();
      },
      delete: (id: string) => Promise.resolve(values.delete(id)),
      list: () => Promise.resolve({}),
    } satisfies CredentialStore;
    await memoryStore.set(PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID, { type: "api", key: "x".repeat(32) });
    await expect(resolvePublicGatewayCredential({ env: {}, store: memoryStore })).resolves.toBe(
      "x".repeat(32),
    );
    await expect(
      resolvePublicGatewayCredential({ env: { CLANKIE_PUBLIC_GATEWAY_TOKEN: "leak" }, store: memoryStore }),
    ).rejects.toThrow(/must not be set/u);
  });
});
