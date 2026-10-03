import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { assertPiModelAuthAllowed } from "@clankie/model-provider";
import type { CredentialStore, ProviderCredential } from "@clankie/credential-broker";
import { MemoryCredentialStore } from "../../../packages/credential-broker/test/memory-store.ts";
import { describe, expect, it, vi } from "vitest";
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

describe("removed and hosted subscription credentials", () => {
  it("refuses stale tokens before refresh and preserves them for owner removal", async () => {
    const broker = new MemoryCredentialStore();
    const token = { type: "oauth" as const, access: "old", refresh: "old-refresh", expires: 1 };
    await broker.set("anthropic", token);
    await broker.set("openai-codex", token);
    for (const [provider, policy, message] of [
      ["anthropic", { env: {} }, "no longer supports Claude"],
      ["openai-codex", { hosted: true }, "pending OpenAI approval"],
    ] as const) {
      const bridge = new BrokerCredentialStore(broker, policy);
      const refresh = vi.fn();
      await expect(bridge.read(provider)).rejects.toThrow(message);
      await expect(bridge.modify(provider, refresh)).rejects.toThrow(message);
      expect(refresh).not.toHaveBeenCalled();
      expect(await broker.get(provider)).toEqual(token);
    }
    await broker.set("anthropic", { type: "api", key: "sk-ant-api03-owned" });
    expect(await new BrokerCredentialStore(broker, { hosted: true }).read("anthropic")).toEqual({
      type: "api_key",
      key: "sk-ant-api03-owned",
    });
  });
});

it("refuses a Claude subscription key resolved through a Pi builtin alias before inference", async () => {
  const broker = new MemoryCredentialStore({ opencode: { type: "api", key: "sk-ant-oat01-old" } });
  const runtime = await ModelRuntime.create({
    credentials: new BrokerCredentialStore(broker),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const model = runtime.getModels("opencode").find((entry) => entry.api === "anthropic-messages")!;
  expect(model).toBeDefined();
  await expect(assertPiModelAuthAllowed(runtime, model)).rejects.toThrow("no longer supports Claude");
  await broker.set("opencode", { type: "api", key: "opencode-api-owned" });
  await expect(assertPiModelAuthAllowed(runtime, model)).resolves.toBeUndefined();
});
