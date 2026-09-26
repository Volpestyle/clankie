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

  it("refreshes one provider one at a time across every store over the same broker", async () => {
    // The captain, the model-keys service and the hosted customer-model loopback
    // each build their own runtime; an OAuth refresh must still run once at a time.
    const values = new Map<string, ProviderCredential>([
      ["openai-codex", { type: "oauth", access: "a0", refresh: "r0", expires: 1, accountId: "account" }],
    ]);
    const broker = {
      get: (id: string) => Promise.resolve(values.get(id)),
      set: (id: string, value: ProviderCredential) => {
        values.set(id, value);
        return Promise.resolve();
      },
      delete: (id: string) => Promise.resolve(values.delete(id)),
      list: () => Promise.resolve({}),
    } satisfies CredentialStore;
    const captain = new BrokerCredentialStore(broker);
    const loopback = new BrokerCredentialStore(broker);
    let inside = 0;
    let most = 0;
    let refreshes = 0;
    // Pi's refresh: re-check under the lock, rotate only if still stale.
    const refresh = (store: BrokerCredentialStore) =>
      store.modify("openai-codex", async (current) => {
        inside++;
        most = Math.max(most, inside);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inside--;
        if (current?.type !== "oauth" || current.access !== "a0") return undefined;
        refreshes++;
        return { ...current, access: "a1", refresh: "r1", expires: Date.now() + 3_600_000 };
      });
    await Promise.all([refresh(captain), refresh(loopback), refresh(captain), refresh(loopback)]);
    expect(most).toBe(1);
    expect(refreshes).toBe(1);
    await expect(loopback.read("openai-codex")).resolves.toMatchObject({ access: "a1", refresh: "r1" });
  });
});
