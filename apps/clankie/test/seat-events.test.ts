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

it("resolves project context and keeps event polls/replies on that binding", async () => {
  const bindings: Array<string | undefined> = [];
  const clankie = await createClankieApp({
    captain: createStubCaptain({
      seatContext: (id) => (id === "project-a" ? { conversationId: id, cwd: "/projects/a" } : undefined),
      pollSeatEvents: async (_wait, _signal, id) => {
        bindings.push(id);
        return [];
      },
      replySeatEvent: async (_event, _text, id) => {
        bindings.push(id);
        return true;
      },
    }),
    authenticateOperator: () => Promise.resolve({ operatorId: "test" }),
  });
  try {
    const context = await clankie.app.request("/v1/captain/seat-context?conversationId=project-a");
    expect(await context.json()).toEqual({ conversationId: "project-a", cwd: "/projects/a" });
    expect((await clankie.app.request("/v1/captain/seat-context?conversationId=missing")).status).toBe(404);
    expect((await clankie.app.request("/v1/mcp?conversationId=missing", { method: "POST" })).status).toBe(
      404,
    );
    expect((await clankie.app.request(`${OPERATOR_SEAT_EVENTS_PATH}?conversationId=project-a`)).status).toBe(
      200,
    );
    expect(
      (
        await clankie.app.request(`${OPERATOR_SEAT_EVENTS_PATH}/event/reply?conversationId=project-a`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: 1, text: "done" }),
        })
      ).status,
    ).toBe(200);
    expect(bindings).toEqual(["project-a", "project-a"]);
  } finally {
    clankie.close();
  }
});

it("accepts only bounded display transcripts for operator conversations", async () => {
  const seen: string[] = [];
  const clankie = await createClankieApp({
    captain: createStubCaptain({
      seatContext: (id) => (id === "project-a" ? { conversationId: id, cwd: "/project" } : undefined),
      syncSeatTranscript: (id) => {
        seen.push(id);
        return seen.length === 1;
      },
    }),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer operator" ? { operatorId: "fixture" } : undefined,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer social"
        ? { captainId: "fixture", steerSourceLane: "discord_text" }
        : undefined,
  });
  const body = {
    sessionId: "cbe70835-228a-4b68-bdae-1b55e984c9a0",
    entries: [{ type: "message", id: "native-entry", role: "agent", text: "hello" }],
  };
  const send = (bearer: string, payload: unknown = body, id = "project-a") =>
    clankie.app.request(`/v1/seat/transcript?conversationId=${id}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  try {
    expect((await send("operator")).status).toBe(200);
    expect((await send("operator")).status).toBe(409);
    expect((await send("social")).status).toBe(403);
    expect((await send("anonymous")).status).toBe(401);
    expect((await send("operator", body, "missing")).status).toBe(404);
    expect(
      (
        await send("operator", {
          ...body,
          entries: [{ type: "viewed_image", id: "image", path: "/private/file" }],
        })
      ).status,
    ).toBe(400);
    expect((await send("operator", { ...body, entries: Array(101).fill(body.entries[0]) })).status).toBe(400);
    expect(seen).toEqual(["project-a", "project-a"]);
  } finally {
    clankie.close();
  }
});
