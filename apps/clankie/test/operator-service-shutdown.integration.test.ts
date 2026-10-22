import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OPERATOR_CONVERSATION_DISPATCH_PATH } from "@clankie/protocol";
import { ClankieSettingsSchema } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { logger } from "../src/app/log.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import type { FleetSeatDelivery } from "../src/captain/fleet-seat.ts";
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A request whose stores close under it while the service shuts down (VUH-2626). */
async function dispatchDuringShutdown(failure: (shutdown: AbortController) => unknown) {
  const root = await mkdtemp(join(tmpdir(), "clankie-operator-shutdown-"));
  roots.push(root);
  const shutdown = new AbortController();
  const serve = createOperatorService({
    shutdown,
    personas: {
      ready: async () => {
        shutdown.abort(new Error("service link interrupted"));
        throw failure(shutdown);
      },
    },
    deps: {},
  } as unknown as CreateOperatorServiceContext);
  const service = await createClankieApp({
    captain: createStubCaptain({ serveOperatorConversation: serve }),
    settings: { load: async () => ClankieSettingsSchema.parse({ schemaVersion: 1 }) },
    eventLogPath: join(root, "events.jsonl"),
    authenticateCaptain: async () => ({ captainId: "captain", steerSourceLane: "api" }),
  });
  const response = await service.app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
    method: "POST",
    headers: { authorization: "Bearer captain", "content-type": "application/json" },
    body: JSON.stringify({ op: "roster", schemaVersion: 1 }),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

it("answers a restart, and logs a real failure that raced the shutdown", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

  const result = await dispatchDuringShutdown(() => new Error("Persona store is closed"));

  expect(result).toEqual({
    status: 503,
    // The marker says this service never answers a restart for a seat send a pane may have (VUH-2670).
    body: { error: "service_restarting", message: "Clankie is restarting", seatHandoff: "reported" },
  });
  expect(warn).toHaveBeenCalledWith(
    {
      event: "operator_conversation.shutdown_error",
      op: "roster",
      error: { name: "Error", message: "Persona store is closed" },
    },
    "A conversation request failed while Clankie was shutting down",
  );
});

it("does not log the shutdown's own abort, which is how a parked tail ends", async () => {
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

  const result = await dispatchDuringShutdown((shutdown) => shutdown.signal.reason);

  expect(result.status).toBe(503);
  expect(warn).not.toHaveBeenCalledWith(
    expect.objectContaining({ event: "operator_conversation.shutdown_error" }),
    expect.anything(),
  );
});

it("never answers a restart for a seat send the worker may already have (VUH-2670)", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const root = await mkdtemp(join(tmpdir(), "clankie-operator-shutdown-"));
  roots.push(root);
  const shutdown = new AbortController();
  const handed: string[] = [];
  // The seat takes the text, then the service starts stopping and the delivery throws.
  const sender = async (_seatId: string, text: string): Promise<FleetSeatDelivery> => {
    handed.push(text);
    shutdown.abort(new Error("service link interrupted"));
    throw new Error("The service link was interrupted.");
  };
  const conversations = new ConversationStore(join(root, "conversations"), vi.fn(), undefined, sender);
  try {
    const serve = createOperatorService({
      shutdown,
      personas: { ready: async () => {} },
      deps: {},
      conversations,
      herdrWatches: { trackSeat: () => {} },
      seatOutboxes: new Map(),
    } as unknown as CreateOperatorServiceContext);
    const created = await serve({
      schemaVersion: 1,
      op: "create",
      scope: { kind: "seat", seatId: "term-one" },
      title: "Worker",
    });
    if (created.op !== "create") throw new Error("create expected");
    const sent = await serve({
      schemaVersion: 1,
      op: "send",
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: created.conversation.conversationId,
        surfaceClientId: "app",
        expectedRevision: 0,
        message: "Run the migration once.",
      },
    });
    // A result, not the 503 a throw during shutdown becomes: the app keeps it uncertain.
    expect(sent).toMatchObject({
      op: "send",
      result: { status: "seat_delivery_unconfirmed", deliveryStage: "uncertain" },
    });
    expect(handed).toEqual(["Run the migration once."]);
  } finally {
    await conversations.close();
  }
});
