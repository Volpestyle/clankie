import type { BodyResource, CallBrowserToolRequest } from "@clankie/protocol";
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
    ) => {
      await authority?.guard?.();
      return { outcome: "ok" as const, tool: request.tool, content: "page", isError: false, artifacts: [] };
    },
  );
  const captain = createStubCaptain();
  captain.seatContext = (id) => (id === "a" || id === "b" ? { conversationId: id, cwd: root } : undefined);
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
