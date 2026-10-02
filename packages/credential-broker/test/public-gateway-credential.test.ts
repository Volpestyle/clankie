import { MemoryCredentialStore } from "./memory-store.ts";
import { describe, expect, it } from "vitest";
import { PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID, resolvePublicGatewayCredential } from "../src/index.ts";

describe("public gateway credential", () => {
  it("reads a valid bearer only from the broker", async () => {
    const memoryStore = new MemoryCredentialStore();
    await memoryStore.set(PUBLIC_GATEWAY_CREDENTIAL_PROVIDER_ID, { type: "api", key: "x".repeat(32) });
    await expect(resolvePublicGatewayCredential({ env: {}, store: memoryStore })).resolves.toBe(
      "x".repeat(32),
    );
    await expect(
      resolvePublicGatewayCredential({ env: { CLANKIE_PUBLIC_GATEWAY_TOKEN: "leak" }, store: memoryStore }),
    ).rejects.toThrow(/must not be set/u);
  });
});
