import type { BodyResource, CallBrowserToolRequest, CallBrowserToolResult } from "@clankie/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { BodyLeaseRouter } from "../src/body-lease-router.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clankie-body-routes-"));
  const store = new BodyLeaseStore(root);
  const router = new BodyLeaseRouter(store);
  let authorized = true;
  const confirmStopped = vi.fn(async (_resource: BodyResource, guard: () => Promise<void>) => {
    await guard();
    return false;
  });
  const call = vi.fn(
    async (
      request: CallBrowserToolRequest,
      _signal?: AbortSignal,
      authority?: { guard?: () => Promise<void> },
    ): Promise<CallBrowserToolResult> => {
      await authority?.guard?.();
      return { outcome: "ok" as const, tool: request.tool, content: "page", isError: false, artifacts: [] };
    },
  );
  const captain = createStubCaptain();
  captain.seatContext = (id) => (id === "a" || id === "b" ? { conversationId: id, cwd: root } : undefined);
  captain.validateConversationOwner = async (owner) =>
    owner.conversationId === "a" || owner.conversationId === "b";
  const app = await createClankieApp({
    captain,
    authenticateOperator: async (request) =>
      authorized && request.headers.get("authorization") === "Bearer owner"
        ? { operatorId: "owner" }
        : undefined,
    bodyLeases: { store, router, confirmStopped },
    browserTools: {
      catalog: async () => ({
        schemaVersion: 1,
        available: true,
        tools: [
          {
            name: "browser_use_close",
            description: "close",
            inputSchema: {},
            requiresApproval: false,
            riskClass: "read",
          },
          {
            name: "browser_use_read",
            description: "read",
            inputSchema: {},
            requiresApproval: false,
            riskClass: "read",
          },
        ],
      }),
      call,
    },
  });
  cleanups.push(async () => {
    await app.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const post = (path: string, payload: unknown, conversationId?: string) =>
    app.app.request(path, {
      method: "POST",
      headers: {
        authorization: "Bearer owner",
        "content-type": "application/json",
        ...(conversationId === undefined ? {} : { "x-clankie-conversation-id": conversationId }),
      },
      body: JSON.stringify(payload),
    });
  return {
    app,
    captain,
    store,
    call,
    post,
    confirmStopped,
    revoke: () => {
      authorized = false;
    },
  };
}

it("requires an authenticated existing writable conversation and returns the other browser owner", async () => {
  const { post, call } = await fixture();
  const request = { schemaVersion: 1, tool: "browser_use_read", arguments: {} };
  expect((await post("/v1/browser/call", request)).status).toBe(409);
  expect((await post("/v1/browser/call", request, "room-inspect-only")).status).toBe(409);
  expect(call).not.toHaveBeenCalled();
  expect(await (await post("/v1/browser/call", request, "a")).json()).toMatchObject({
    result: { outcome: "ok" },
  });
  expect(await (await post("/v1/browser/call", request, "b")).json()).toMatchObject({
    result: { outcome: "busy", lease: { conversationId: "a" } },
  });
  expect(call).toHaveBeenCalledTimes(1);
});

it("ordinary release verifies actual stop and cannot use a stale token", async () => {
  const { post, store, confirmStopped } = await fixture();
  const acquired = await (
    await post("/v1/body-leases", { action: "acquire", conversationId: "a", resource: "voice", ttlMs: 1000 })
  ).json();
  const result = await (
    await post("/v1/body-leases", {
      action: "release",
      conversationId: "a",
      resource: "voice",
      incarnation: acquired.incarnation,
    })
  ).json();
  expect(result).toEqual({ outcome: "rejected", reason: "recovery_required" });
  expect(confirmStopped).toHaveBeenCalledTimes(1);
  expect(store.status("voice")?.conversationId).toBe("a");
});

it("an attachable room context does not grant generic operator body authority", async () => {
  const { post, call, captain, store } = await fixture();
  captain.seatContext = (id) => (id === "room-attached" ? { conversationId: id, cwd: "/tmp" } : undefined);
  const result = await (
    await post(
      "/v1/browser/call",
      {
        schemaVersion: 1,
        tool: "browser_use_read",
        arguments: {},
      },
      "room-attached",
    )
  ).json();
  expect(result).toMatchObject({ result: { outcome: "rejected", reason: "not_authorized" } });
  expect(call).not.toHaveBeenCalled();
  expect(store.status("browser")).toBeUndefined();
});

it("retains the browser claim when close is refused", async () => {
  const { post, call, store } = await fixture();
  await post("/v1/browser/call", { schemaVersion: 1, tool: "browser_use_read", arguments: {} }, "a");
  call.mockResolvedValueOnce({ outcome: "refused", tool: "browser_use_close", reason: "approval_required" });
  await post("/v1/browser/call", { schemaVersion: 1, tool: "browser_use_close", arguments: {} }, "a");
  expect(store.status("browser")).toMatchObject({ conversationId: "a", state: "recovery_required" });
});

it.each(["acquire", "renew"])("reauthorizes %s after seat lookup", async (action) => {
  const { post, store, captain, revoke } = await fixture();
  const held = store.acquire("voice", "a", 1000);
  if (held.outcome !== "acquired") throw new Error("fixture acquire");
  const expiresAt = store.status("voice")?.expiresAt;
  if (action === "acquire") store.release(held.lease);
  captain.seatContext = (id) => {
    revoke();
    return { conversationId: id ?? "a", cwd: "/tmp" };
  };
  const response = await post("/v1/body-leases", {
    action,
    conversationId: "a",
    resource: "voice",
    ttlMs: 2000,
    ...(action === "renew" ? { incarnation: held.lease.token } : {}),
  });
  expect(await response.json()).toEqual({ outcome: "rejected", reason: "not_authorized" });
  if (action === "acquire") expect(store.status("voice")).toBeUndefined();
  else expect(store.status("voice")?.expiresAt).toBe(expiresAt);
});

it("requires separate operator authority for explicit head designation and rejects extra fields", async () => {
  const f = await fixture();
  const designation = vi.fn(async () => ({ conversationId: "a" }) as never);
  f.captain.setDesignatedConversationHead = designation;
  expect(
    (await f.post("/v1/conversation-heads", { conversationId: "a", headConversationId: "b" })).status,
  ).toBe(200);
  expect(designation).toHaveBeenCalledWith("a", "b");
  expect(
    (
      await f.post("/v1/conversation-heads", {
        conversationId: "a",
        headConversationId: "b",
        grant: "operator",
      })
    ).status,
  ).toBe(400);
  f.revoke();
  expect(
    (await f.post("/v1/conversation-heads", { conversationId: "a", headConversationId: null })).status,
  ).toBe(401);
  expect(designation).toHaveBeenCalledTimes(1);
});
