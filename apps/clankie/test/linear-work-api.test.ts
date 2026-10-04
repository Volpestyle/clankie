import { afterEach, expect, it, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import type { ConversationAuthority } from "../src/captain/conversation-owner.ts";
import type { LinearWorkOwner } from "../src/linear-webhook.ts";

const organizationId = "96d2a27b-950b-4a8a-afae-8776605c0ef1";
const issueId = "593644be-7b60-4a77-9b58-7b0dc20be894";
const binding = { organizationId, issueId, conversationId: "lead-conversation" };
const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});

async function fixture() {
  let authorized = true;
  const bind = vi.fn(
    async (_binding: LinearWorkOwner, source: ConversationAuthority) =>
      source.current() && (await source.authorize()) && source.current(),
  );
  const unbind = vi.fn(() => true);
  const handoff = vi.fn(async () => true);
  const captain = createStubCaptain({
    seatContext: (id) =>
      id === "lead-conversation" || id === "room-inspectable"
        ? { conversationId: id, cwd: "/tmp" }
        : undefined,
    validateConversationOwner: async (owner) => owner.conversationId === "lead-conversation",
    linearWorkOwners: () => [binding],
    bindLinearWorkOwner: bind,
    unbindLinearWorkOwner: unbind,
    handoffLinearActivity: handoff,
  });
  const { app, close } = await createClankieApp({
    captain,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" && authorized
        ? { operatorId: "owner" }
        : undefined,
  });
  closes.push(close);
  const request = (path: string, method: string, body?: unknown, token = "owner") =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    app,
    captain,
    bind,
    unbind,
    handoff,
    request,
    revoke: () => {
      authorized = false;
    },
  };
}

it("requires the operator for work reads, binding mutations and explicit inbox handoff", async () => {
  const f = await fixture();
  for (const [path, method, body] of [
    ["/v1/linear/work", "GET", undefined],
    ["/v1/linear/work", "PUT", binding],
    ["/v1/linear/work", "DELETE", { organizationId, issueId }],
    ["/v1/linear/inbox/handoff", "POST", { cursor: "000000000001" }],
  ] as const)
    expect((await f.request(path, method, body, "captain")).status).toBe(401);
  expect(f.bind).not.toHaveBeenCalled();
  expect(f.unbind).not.toHaveBeenCalled();
  expect(f.handoff).not.toHaveBeenCalled();
  expect(await (await f.request("/v1/linear/work", "GET")).json()).toEqual({ owners: [binding] });
});

it("supplies host-bound conversation authority and refuses unknown or room inspection targets", async () => {
  const f = await fixture();
  const response = await f.request("/v1/linear/work", "PUT", binding);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ schemaVersion: 1, bound: binding });
  const source = f.bind.mock.calls[0]![1];
  expect(source.owner).toEqual({ conversationId: binding.conversationId });
  expect(source.current()).toBe(true);
  expect(await source.authorize()).toBe(true);
  for (const conversationId of ["unknown", "room-inspectable"]) {
    const refused = await f.request("/v1/linear/work", "PUT", { ...binding, conversationId });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "linear_work_owner_refused" });
  }
  expect(f.bind).toHaveBeenCalledTimes(1);
  f.bind.mockImplementationOnce(async (_binding, source) => {
    f.revoke();
    return source.current() && (await source.authorize());
  });
  expect((await f.request("/v1/linear/work", "PUT", binding)).status).toBe(409);
  expect(await source.authorize()).toBe(false);
});

it("validates exact organization and issue pairs and never accepts caller-selected handoff routes", async () => {
  const f = await fixture();
  for (const malformed of [null, { ...binding, issueId: "VUH-1611" }, { ...binding, owner: "room" }])
    expect((await f.request("/v1/linear/work", "PUT", malformed)).status).toBe(400);
  for (const malformed of [binding, { organizationId, issueId: "short" }, { issueId }])
    expect((await f.request("/v1/linear/work", "DELETE", malformed)).status).toBe(400);
  expect(await (await f.request("/v1/linear/work", "DELETE", { organizationId, issueId })).json()).toEqual({
    schemaVersion: 1,
    unbound: true,
  });
  expect(f.unbind).toHaveBeenCalledExactlyOnceWith(organizationId, issueId);
  for (const malformed of [
    { cursor: "1" },
    { cursor: "000000000001", conversationId: "caller-choice" },
    null,
  ])
    expect((await f.request("/v1/linear/inbox/handoff", "POST", malformed)).status).toBe(400);
  expect(
    await (await f.request("/v1/linear/inbox/handoff", "POST", { cursor: "000000000001" })).json(),
  ).toEqual({
    schemaVersion: 1,
    handedOff: "000000000001",
  });
  expect(f.handoff).toHaveBeenCalledExactlyOnceWith("000000000001");
  f.handoff.mockResolvedValueOnce(false);
  const refused = await f.request("/v1/linear/inbox/handoff", "POST", { cursor: "000000000099" });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "linear_handoff_refused" });
});

it("fails closed when operator authentication is unavailable", async () => {
  const captain = createStubCaptain();
  const { app, close } = await createClankieApp({ captain });
  closes.push(close);
  for (const method of ["GET", "PUT", "DELETE"])
    expect((await app.request("/v1/linear/work", { method })).status).toBe(503);
  expect((await app.request("/v1/linear/inbox/handoff", { method: "POST" })).status).toBe(503);
});
