import { expect, it } from "vitest";
import { OperatorConversationServiceResultSchema } from "@clankie/protocol";
import { createHerdrSessionSource, type HerdrSessionPort } from "../src/sessions/herdr.ts";

// The real session adapter consumes strict service responses. These are transport
// facts; neither an accepted run nor a queued input proves native execution.
const at = "2026-11-04T12:00:00.000Z";
function fixture(outcome: "accepted" | "queued" | "unconfirmed" | "offline") {
  let sends = 0;
  const port: HerdrSessionPort = {
    async dispatch(request) {
      if (request.op === "fleet")
        return OperatorConversationServiceResultSchema.parse({
          op: "fleet",
          schemaVersion: 1,
          snapshot: {
            schemaVersion: 1,
            cursor: "c1",
            personas: [],
            channels: [],
            seats: [
              {
                seatId: "fixture/t1",
                occupantId: "occupant-1",
                personaId: "p-one",
                harness: "codex",
                status: "working",
                title: "Fixture worker",
                fleet: "fixture",
              },
            ],
          },
        });
      if (request.op === "create")
        return OperatorConversationServiceResultSchema.parse({
          op: "create",
          schemaVersion: 1,
          conversation: {
            schemaVersion: 1,
            conversationId: "conv-one",
            scope: request.scope,
            title: "Fixture",
            isDefault: false,
            createdAt: at,
            updatedAt: at,
            sessionState: "active",
            revision: 1,
          },
        });
      if (request.op !== "send") throw new Error(`Unexpected operation ${request.op}`);
      sends += 1;
      const result =
        outcome === "unconfirmed"
          ? {
              schemaVersion: 1,
              status: "seat_delivery_unconfirmed",
              conversationId: "conv-one",
              currentRevision: 1,
              safeCursor: "c1",
              detail: "Unconfirmed",
              messageId: "native-input-1",
            }
          : outcome === "offline"
            ? {
                schemaVersion: 1,
                status: "seat_offline",
                conversationId: "conv-one",
                currentRevision: 1,
                safeCursor: "c1",
              }
            : {
                schemaVersion: 1,
                status: "accepted",
                conversationId: "conv-one",
                runId: "service-run-1",
                revision: 2,
                safeCursor: "c2",
                ...(outcome === "queued"
                  ? { seatDelivery: { state: "queued", detail: "Waiting for the current turn" } }
                  : {}),
              };
      return OperatorConversationServiceResultSchema.parse({ op: "send", schemaVersion: 1, result });
    },
    async terminalTail() {
      throw new Error("Send must not inspect screen contents");
    },
    async tailRefusal() {
      throw new Error("Send must not inspect screen contents");
    },
  };
  return { port, sends: () => sends };
}

it("keeps legacy results identical while an opted-in adapter preserves service attribution", async () => {
  const { port, sends } = fixture("accepted");
  const legacy = createHerdrSessionSource(port, { surfaceClientId: "fixture-client" });
  expect(await legacy.send("fixture/t1", "message")).toEqual({
    id: "fixture/t1",
    status: "delivered",
    detail: "Sent to Fixture worker. Read the agent to see it respond.",
  });
  const optedIn = createHerdrSessionSource(port, {
    surfaceClientId: "fixture-client",
    includeSendIdentity: true,
  });
  expect(await optedIn.send("fixture/t1", "message")).toMatchObject({
    status: "delivered",
    identity: {
      seatId: "fixture/t1",
      occupantId: "occupant-1",
      fleet: "fixture",
      conversationId: "conv-one",
      runId: "service-run-1",
    },
  });
  expect((await optedIn.send("fixture/t1", "message")).identity).not.toHaveProperty("messageId");
  expect(sends()).toBe(3);
});

it("preserves queued status and never labels the bookkeeping run as a native input", async () => {
  const { port } = fixture("queued");
  const source = createHerdrSessionSource(port, {
    surfaceClientId: "fixture-client",
    includeSendIdentity: true,
  });
  const result = await source.send("fixture/t1", "message");
  expect(result).toMatchObject({ status: "queued", identity: { runId: "service-run-1" } });
  expect(result.identity).not.toHaveProperty("messageId");
});

it("retains an actual unconfirmed native input ID without changing the status or resending", async () => {
  const { port, sends } = fixture("unconfirmed");
  const source = createHerdrSessionSource(port, {
    surfaceClientId: "fixture-client",
    includeSendIdentity: true,
  });
  const result = await source.send("fixture/t1", "message");
  expect(result).toMatchObject({ status: "unconfirmed", identity: { messageId: "native-input-1" } });
  expect(result.identity).not.toHaveProperty("runId");
  expect(sends()).toBe(1);
});

it("does not attach a delivery identity to an offline refusal", async () => {
  const { port } = fixture("offline");
  const source = createHerdrSessionSource(port, {
    surfaceClientId: "fixture-client",
    includeSendIdentity: true,
  });
  const result = await source.send("fixture/t1", "message");
  expect(result.status).toBe("offline");
  expect(result.identity).toBeUndefined();
});
