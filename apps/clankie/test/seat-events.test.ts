import { OPERATOR_SEAT_EVENTS_PATH, type OperatorSeatEvent } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";

const event: OperatorSeatEvent = {
  schemaVersion: 1,
  id: "seat-1",
  kind: "escalation",
  conversationId: "global-default",
  source: "clankie-menu-bar-voice",
  content: "can you check the build?",
  createdAt: "2026-09-01T20:00:00.000Z",
};

async function app(polled: number[] = [], replies: [string, string][] = []) {
  return createClankieApp({
    captain: createStubCaptain({
      pollSeatEvents: async (waitMs) => {
        polled.push(waitMs);
        return [event];
      },
      replySeatEvent: async (id, text) => {
        replies.push([id, text]);
        return id === "seat-1";
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

/** Only the operator's own bearer reaches the outbox (ADR 0152). */
describe("seat outbox routes", () => {
  it("serves the operator's poll, caps the wait, and takes the reply", async () => {
    const polled: number[] = [];
    const replies: [string, string][] = [];
    const clankie = await app(polled, replies);
    const page = await clankie.app.request(`${OPERATOR_SEAT_EVENTS_PATH}?wait=99999`, {
      headers: { authorization: "Bearer operator" },
    });
    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({ schemaVersion: 1, events: [event] });
    expect(polled).toEqual([30_000]);

    const replied = await clankie.app.request(`${OPERATOR_SEAT_EVENTS_PATH}/seat-1/reply`, {
      method: "POST",
      headers: { authorization: "Bearer operator", "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, text: "green" }),
    });
    expect(replied.status).toBe(200);
    const stale = await clankie.app.request(`${OPERATOR_SEAT_EVENTS_PATH}/seat-9/reply`, {
      method: "POST",
      headers: { authorization: "Bearer operator", "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, text: "late" }),
    });
    expect(stale.status).toBe(404);
    const malformed = await clankie.app.request(`${OPERATOR_SEAT_EVENTS_PATH}/seat-1/reply`, {
      method: "POST",
      headers: { authorization: "Bearer operator", "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, text: "" }),
    });
    expect(malformed.status).toBe(400);
    expect(replies).toEqual([
      ["seat-1", "green"],
      ["seat-9", "late"],
    ]);
    clankie.close();
  });

  it("refuses a social bearer and an anonymous caller", async () => {
    const clankie = await app();
    const social = await clankie.app.request(OPERATOR_SEAT_EVENTS_PATH, {
      headers: { authorization: "Bearer discord" },
    });
    expect(social.status).toBe(403);
    const anonymous = await clankie.app.request(OPERATOR_SEAT_EVENTS_PATH);
    expect(anonymous.status).toBe(401);
    clankie.close();
  });
});
