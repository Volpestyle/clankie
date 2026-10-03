import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { BodyLeaseRouter } from "../src/body-lease-router.ts";
import { pumpBodyRequests } from "../src/body-request-pump.ts";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "body-request-pump-"));
  const store = new BodyLeaseStore(root);
  const router = new BodyLeaseRouter(store);
  cleanup.push(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const owner = {
    conversationId: "owner",
    route: { owner: { conversationId: "owner" }, mode: "machine" as const },
    current: () => true,
    authorize: async () => true,
  };
  const requester = {
    conversationId: "requester",
    route: { owner: { conversationId: "requester" }, mode: "social" as const },
    current: () => true,
    authorize: async () => true,
  };
  const claim = store.acquire("browser", owner.conversationId, 10000, owner.route);
  if (claim.outcome !== "acquired") throw new Error("claim");
  return { store, router, owner, requester, claim };
}
it("delivers an explicit ask only to the captured holder and queues no effect", async () => {
  const f = setup();
  await f.router.request(f.requester, {
    resource: "browser",
    kind: "ask",
    text: "Could you finish?",
    ttlMs: 10000,
  });
  const wakes: unknown[] = [];
  await pumpBodyRequests(f.router, {
    validateConversationOwner: async () => true,
    wakeConversation: async (owner, text, guard, mode) => {
      await guard?.();
      wakes.push({ owner, text, mode });
      return true;
    },
  });
  expect(wakes).toEqual([
    { owner: f.owner.route.owner, text: expect.stringContaining("Could you finish?"), mode: "machine" },
  ]);
  expect(f.store.status("browser")?.conversationId).toBe("owner");
});
it("wakes the captured social requester only after release and preserves its mode", async () => {
  const f = setup();
  await f.router.request(f.requester, { resource: "browser", kind: "queue", text: "next", ttlMs: 10000 });
  const wakes: unknown[] = [];
  const captain = {
    validateConversationOwner: async () => true,
    wakeConversation: async (
      owner: unknown,
      _text: string,
      guard?: () => Promise<void>,
      mode?: "machine" | "social",
    ) => {
      await guard?.();
      wakes.push({ owner, mode });
      return true;
    },
  };
  await pumpBodyRequests(f.router, captain);
  expect(wakes).toEqual([]);
  f.store.release(f.claim.lease);
  await pumpBodyRequests(f.router, captain);
  expect(wakes).toEqual([{ owner: f.requester.route.owner, mode: "social" }]);
  expect(f.store.status("browser")).toBeUndefined();
});
it("rechecks requester authority at eventual wake and never retries uncertain delivery", async () => {
  const f = setup();
  await f.router.request(f.requester, { resource: "browser", kind: "ask", text: "question", ttlMs: 10000 });
  let sourceAllowed = true;
  let effects = 0;
  const captain = {
    validateConversationOwner: async (owner: { conversationId: string }) =>
      owner.conversationId !== "requester" || sourceAllowed,
    wakeConversation: async (_owner: unknown, _text: string, guard?: () => Promise<void>) => {
      sourceAllowed = false;
      await guard?.();
      effects++;
      return true;
    },
  };
  expect(await pumpBodyRequests(f.router, captain)).toMatchObject([
    { outcome: "asked", deliveryStage: "uncertain" },
  ]);
  expect(effects).toBe(0);
  sourceAllowed = true;
  expect(await pumpBodyRequests(f.router, captain)).toEqual([]);
});
it("does not redirect an ask to a replacement incarnation or unknown holder route", async () => {
  const f = setup();
  await f.router.request(f.requester, { resource: "browser", kind: "ask", text: "question", ttlMs: 10000 });
  f.store.release(f.claim.lease);
  f.store.acquire("browser", "owner", 10000, f.owner.route);
  let effects = 0;
  await pumpBodyRequests(f.router, {
    validateConversationOwner: async () => true,
    wakeConversation: async () => {
      effects++;
      return true;
    },
  });
  expect(effects).toBe(0);
});
