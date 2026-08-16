import type { CredentialStore, ProviderCredential } from "@clankie/credential-broker";
import { describe, expect, it } from "vitest";
import { BrokerCredentialStore } from "../src/captain/model.ts";

describe("captain Pi credential bridge", () => {
  it("preserves credentials when Pi modify returns undefined", async () => {
    const values = new Map<string, ProviderCredential>([
      [
        "openai-codex",
        { type: "oauth", access: "access", refresh: "refresh", expires: 123, accountId: "account" },
      ],
    ]);
    const store = {
      get: (id: string) => Promise.resolve(values.get(id)),
      set: (id: string, value: ProviderCredential) => {
        values.set(id, value);
        return Promise.resolve();
      },
      delete: (id: string) => Promise.resolve(values.delete(id)),
      list: () => Promise.resolve({}),
    } satisfies CredentialStore;
    const bridge = new BrokerCredentialStore(store);

    await expect(bridge.modify("openai-codex", async () => undefined)).resolves.toMatchObject({
      type: "oauth",
      accountId: "account",
    });
    await expect(bridge.read("openai-codex")).resolves.toMatchObject({ accountId: "account" });
    expect(values.get("openai-codex")).toMatchObject({ accountId: "account" });
  });
});
