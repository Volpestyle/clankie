import { fleetSeatEventsPath, fleetSeatHookPath, type OperatorSeatEvent } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";

const event: OperatorSeatEvent = {
  schemaVersion: 1,
  id: "seat-1",
  kind: "message",
  conversationId: "conv-potato",
  source: "operator",
  content: "Please finish the tests",
  createdAt: "2026-09-06T20:00:00.000Z",
};

const paneId = "w1Z:p6";

async function app(polled: { paneId: string; waitMs: number }[] = []) {
  return createClankieApp({
    captain: createStubCaptain({
      pollFleetSeatEvents: async (requestedPaneId, waitMs) => {
        polled.push({ paneId: requestedPaneId, waitMs });
        return requestedPaneId === paneId ? [event] : undefined;
      },
    }),
    authenticateOperator: (request) =>
      Promise.resolve(
        request.headers.get("authorization") === "Bearer operator"
          ? { operatorId: "local-operator", steerSourceLane: "tui" as const }
          : undefined,
      ),
    authenticateCaptain: (request) =>
      Promise.resolve(
        request.headers.get("authorization") === "Bearer discord"
          ? { captainId: "discord-bridge", steerSourceLane: "discord_text" as const }
          : undefined,
      ),
  });
}

describe("fleet seat mailbox routes", () => {
  it("serves the operator's poll, caps the wait, and 404s an unknown seat", async () => {
    const polled: { paneId: string; waitMs: number }[] = [];
    const clankie = await app(polled);
    const page = await clankie.app.request(`${fleetSeatEventsPath(paneId)}?wait=99999`, {
      headers: { authorization: "Bearer operator" },
    });
    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({ schemaVersion: 1, events: [event] });
    expect(polled).toEqual([{ paneId, waitMs: 30_000 }]);

    const missing = await clankie.app.request(fleetSeatEventsPath("gone"), {
      headers: { authorization: "Bearer operator" },
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "unknown_seat" });
    clankie.close();
  });

  it("refuses a social bearer and an anonymous caller", async () => {
    const clankie = await app();
    const social = await clankie.app.request(fleetSeatEventsPath(paneId), {
      headers: { authorization: "Bearer discord" },
    });
    expect(social.status).toBe(403);
    const anonymous = await clankie.app.request(fleetSeatEventsPath(paneId));
    expect(anonymous.status).toBe(401);
    clankie.close();
  });
});

describe("fleet seat hook route", () => {
  it("records the operator's hook for the pane it names, and refuses anything else", async () => {
    const recorded: unknown[] = [];
    const clankie = await createClankieApp({
      captain: createStubCaptain({
        recordSeatHook: async (requestedPaneId, hook) => {
          recorded.push({ requestedPaneId, hook });
          return requestedPaneId === paneId;
        },
      }),
      authenticateOperator: (request) =>
        Promise.resolve(
          request.headers.get("authorization") === "Bearer operator"
            ? { operatorId: "local-operator", steerSourceLane: "tui" as const }
            : undefined,
        ),
      authenticateCaptain: (request) =>
        Promise.resolve(
          request.headers.get("authorization") === "Bearer discord"
            ? { captainId: "discord-bridge", steerSourceLane: "discord_text" as const }
            : undefined,
        ),
    });
    const hook = { schemaVersion: 1, event: "Stop", sessionId: "s-1", lastMessage: "done" };
    const post = (target: string, body: unknown, bearer = "operator") =>
      clankie.app.request(fleetSeatHookPath(target), {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const ok = await post(paneId, hook);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ schemaVersion: 1, recorded: true });
    expect(recorded).toEqual([{ requestedPaneId: paneId, hook }]);
    expect((await post("gone", hook)).status).toBe(404);
    expect((await post(paneId, { ...hook, event: "Notification" })).status).toBe(400);
    expect((await post(paneId, hook, "discord")).status).toBe(403);
    clankie.close();
  });
});

it("keeps exact fleet acknowledgments behind the same pane authorization as polling", async () => {
  const calls: string[] = [];
  const clankie = await createClankieApp({
    captain: createStubCaptain({
      acknowledgeFleetSeatEvent: async (pane, id) => {
        calls.push(`${pane}/${id}`);
        return pane === paneId && id === "original";
      },
    }),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer operator"
        ? { operatorId: "owner", steerSourceLane: "tui" }
        : undefined,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer social"
        ? { captainId: "social", steerSourceLane: "discord_text" }
        : undefined,
  });
  try {
    const uri = `${fleetSeatEventsPath(paneId)}/original/ack`;
    expect(
      (await clankie.app.request(uri, { method: "POST", headers: { authorization: "Bearer social" } }))
        .status,
    ).toBe(403);
    expect(calls).toEqual([]);
    const ack = await clankie.app.request(uri, {
      method: "POST",
      headers: { authorization: "Bearer operator" },
    });
    expect(await ack.json()).toMatchObject({ acknowledged: true, deliveryStage: "delivered" });
    expect(calls).toEqual([`${paneId}/original`]);
  } finally {
    clankie.close();
  }
});

it("reports inbound conversation retention as stored, preserving its received boolean", async () => {
  const clankie = await createClankieApp({
    captain: createStubCaptain({ receiveFleetSeatMessage: async (pane) => pane === paneId }),
    authenticateOperator: async () => ({ operatorId: "owner", steerSourceLane: "tui" }),
  });
  try {
    const request = (pane: string, body: unknown) =>
      clankie.app.request(`/v1/fleet/seats/${encodeURIComponent(pane)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const delivery = { id: "00000000-0000-4000-8000-000000000001", binding: "a".repeat(64) };
    expect((await request(paneId, { schemaVersion: 1, text: "legacy" })).status).toBe(400);
    const result = await request(paneId, { schemaVersion: 1, text: "progress", delivery });
    expect(await result.json()).toEqual({ schemaVersion: 1, received: true, deliveryStage: "stored" });
    expect((await request("missing", { schemaVersion: 1, text: "progress", delivery })).status).toBe(404);
    expect(await (await request(paneId, {})).json()).toMatchObject({ deliveryStage: "rejected" });
  } finally {
    clankie.close();
  }
});
