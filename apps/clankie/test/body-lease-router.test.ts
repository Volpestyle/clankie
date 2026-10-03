import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BodyLeaseRouter, type BodyConversationIdentity } from "../src/body-lease-router.ts";
import { BodyLeaseStore } from "../src/body-leases.ts";
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clankie-body-router-"));
  roots.push(root);
  const store = new BodyLeaseStore(root);
  return { store, router: new BodyLeaseRouter(store) };
}
function identity(conversationId: string): BodyConversationIdentity {
  return { conversationId, current: () => true, authorize: async () => true };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("two independent seats conflict without executing the second body effect", async () => {
  const { store, router } = fixture();
  const second = vi.fn();
  expect(
    (await router.run(identity("a"), "browser", async () => "opened", { lifetime: "session" })).outcome,
  ).toBe("completed");
  expect(await router.run(identity("b"), "browser", second, { lifetime: "session" })).toMatchObject({
    outcome: "busy",
    lease: { conversationId: "a" },
    actions: ["queue", "ask"],
  });
  expect(second).not.toHaveBeenCalled();
  store.close();
});

it("lease ownership never bypasses denied grants or an async identity change", async () => {
  const { store, router } = fixture();
  const effect = vi.fn();
  expect(
    await router.run({ ...identity("a"), authorize: async () => false }, "voice", effect, {
      lifetime: "session",
    }),
  ).toEqual({ outcome: "rejected", reason: "not_authorized" });
  let current = true;
  expect(
    await router.run(
      {
        ...identity("a"),
        current: () => current,
        authorize: async () => {
          current = false;
          return true;
        },
      },
      "voice",
      effect,
      { lifetime: "session" },
    ),
  ).toEqual({ outcome: "rejected", reason: "identity_required" });
  expect(effect).not.toHaveBeenCalled();
  expect(store.status("voice")).toBeUndefined();
  store.close();
});

it("a final body guard fences authority revoked during async discovery", async () => {
  const { store, router } = fixture();
  let allowed = true;
  const effect = vi.fn();
  const actor = { ...identity("a"), authorize: async () => allowed };
  const result = await router.run(
    actor,
    "browser",
    async (guard) => {
      await Promise.resolve();
      allowed = false;
      await guard();
      effect();
    },
    { lifetime: "session" },
  );
  expect(result).toEqual({ outcome: "rejected", reason: "not_authorized" });
  expect(effect).not.toHaveBeenCalled();
  expect(store.status("browser")?.state).toBe("recovery_required");
  store.close();
});

it("recovery requires a confirmed stop and prevents replacement during its await", async () => {
  const { store, router } = fixture();
  await router.run(identity("a"), "play", async () => "running", { lifetime: "session" });
  expect(await router.recover(identity("a"), "play", async () => false)).toEqual({
    outcome: "rejected",
    reason: "recovery_required",
  });
  expect(store.status("play")).toBeDefined();
  const result = await router.recover(identity("a"), "play", async () => {
    const original = store.recoveryReference("play")!;
    expect(store.reconcileStopped(original).outcome).toBe("rejected");
    expect(store.acquire("play", "b", 1000).outcome).toBe("busy");
    return true;
  });
  expect(result).toEqual({ outcome: "released" });
  expect(store.status("play")).toBeUndefined();
  store.close();
});

it("queues only an explicit scoped wake, persists attempted delivery, and never replays uncertainty", async () => {
  const { store, router } = fixture();
  await router.run(identity("a"), "browser", async () => "open", { lifetime: "session" });
  const queued = await router.request(identity("b"), {
    kind: "queue",
    resource: "browser",
    text: "My browsing task is waiting",
    ttlMs: 1000,
  });
  expect(queued.outcome).toBe("queued");
  const deliver = vi.fn(async () => "uncertain" as const);
  const ports = {
    identity: async (id: string) => identity(id),
    authorizeDelivery: async () => true,
    designatedHead: () => undefined,
    deliver,
  };
  expect(await router.deliverRequests(ports)).toEqual([]);
  await router.recover(identity("a"), "browser", async () => true);
  expect(await router.deliverRequests(ports)).toMatchObject([
    { outcome: "asked", deliveryStage: "uncertain" },
  ]);
  expect(deliver).toHaveBeenCalledExactlyOnceWith(
    "b",
    {
      requester: "b",
      resource: "browser",
      text: "My browsing task is waiting",
      kind: "queue",
    },
    expect.any(Function),
  );
  expect(await router.deliverRequests(ports)).toEqual([]);
  expect(store.status("browser")).toBeUndefined();
  store.close();
});

it("ask never falls back to default head and rechecks route permission", async () => {
  const { store, router } = fixture();
  await router.run(identity("a"), "voice", async () => "joined", { lifetime: "session" });
  await router.request(identity("b"), {
    kind: "ask",
    resource: "voice",
    text: "May I use voice next?",
    ttlMs: 1000,
  });
  const deliver = vi.fn(async () => "consumed" as const);
  const ports = {
    identity: async (id: string) => (id === "a" ? undefined : identity(id)),
    authorizeDelivery: async () => false,
    designatedHead: () => undefined,
    deliver,
  };
  expect(await router.deliverRequests(ports)).toEqual([]);
  expect(deliver).not.toHaveBeenCalled();
  expect(await router.deliverRequests({ ...ports, designatedHead: () => "explicit-head" })).toEqual([]);
  expect(deliver).not.toHaveBeenCalled();
  expect(
    await router.deliverRequests({
      ...ports,
      designatedHead: () => "explicit-head",
      authorizeDelivery: async () => true,
    }),
  ).toMatchObject([{ deliveryStage: "consumed" }]);
  expect(deliver).toHaveBeenCalledWith(
    "explicit-head",
    expect.objectContaining({ requester: "b" }),
    expect.any(Function),
  );
  store.close();
});

it("a queued request cannot survive an intervening replacement holder", async () => {
  const { store, router } = fixture();
  await router.run(identity("a"), "play", async () => "running", { lifetime: "session" });
  await router.request(identity("b"), { kind: "queue", resource: "play", text: "Next", ttlMs: 1000 });
  await router.recover(identity("a"), "play", async () => true);
  await router.run(identity("c"), "play", async () => "running", { lifetime: "session" });
  await router.recover(identity("c"), "play", async () => true);
  expect(store.pendingRequests()).toEqual([]);
  store.close();
});

it("preserves each successful send receipt when same-conversation operations overlap", async () => {
  const { store, router } = fixture();
  let finishFirst!: () => void;
  let finishSecond!: () => void;
  let startedFirst!: () => void;
  let startedSecond!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    startedFirst = resolve;
  });
  const secondStarted = new Promise<void>((resolve) => {
    startedSecond = resolve;
  });
  const firstWait = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const secondWait = new Promise<void>((resolve) => {
    finishSecond = resolve;
  });
  const first = router.run(
    identity("a"),
    "discord_mouth",
    async () => {
      startedFirst();
      await firstWait;
      return { messageId: "one" };
    },
    { lifetime: "operation" },
  );
  await firstStarted;
  const second = router.run(
    identity("a"),
    "discord_mouth",
    async () => {
      startedSecond();
      await secondWait;
      return { messageId: "two" };
    },
    { lifetime: "operation" },
  );
  await secondStarted;
  finishFirst();
  expect(await first).toMatchObject({ outcome: "completed", value: { messageId: "one" } });
  expect(store.status("discord_mouth")).toBeDefined();
  finishSecond();
  expect(await second).toMatchObject({ outcome: "completed", value: { messageId: "two" } });
  expect(store.status("discord_mouth")).toBeUndefined();
  store.close();
});
