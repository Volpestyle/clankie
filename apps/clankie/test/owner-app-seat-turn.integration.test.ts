import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OperatorSeatEventSchema,
  TAKE_CONTROL_GRANTS,
  type OperatorConversationServiceRequest,
} from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { afterEach, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import { createConversationRunner } from "../src/captain/captain-conversation-runner.ts";
import { seatEventKindFor } from "../src/captain/captain-session.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { LaneLog } from "../src/captain/lane-log.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";
import { TurnSettledLog } from "../src/captain/turn-metrics.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";

// Real device authentication, owner route, conversation driver/admission, seat
// mailbox and transcript projection. No model/session replacement or live probes.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const ID = "global-default";
const DEVICE = "owner-phone";
const BINDING = "native-seat-fixture";
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "owner-app-seat-turn-"));
  const now = Date.now();
  const key = randomBytes(32);
  const token = new DeviceSessionSigner(key).issue(
    mintDeviceSessionClaims({ deviceId: DEVICE, nowEpochSeconds: Math.floor(now / 1000), ttlSeconds: 600 }),
  );
  const base = {
    occurredAt: new Date(now).toISOString(),
    missionId: `device:${DEVICE}`,
    correlationId: "fixture",
    profileHash: "fixture",
  };
  const events = [
    {
      ...base,
      id: randomUUID(),
      type: "device.pairing.redeemed",
      data: {
        schemaVersion: 1,
        deviceId: DEVICE,
        offerId: DEVICE,
        name: "Owner phone",
        platform: "ios",
        offeredGrants: TAKE_CONTROL_GRANTS,
        mintedBy: "local-owner",
        pendingExpiresAt: new Date(now + 600000).toISOString(),
      },
    },
    {
      ...base,
      id: randomUUID(),
      type: "device.activated",
      data: {
        schemaVersion: 1,
        deviceId: DEVICE,
        grants: TAKE_CONTROL_GRANTS,
        sessionExpiresAt: new Date(now + 600000).toISOString(),
      },
    },
  ];
  const eventLogPath = join(root, "events.jsonl");
  writeFileSync(eventLogPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const settings = new SettingsStore(join(root, "settings.json"));
  const autonomy = new AutonomyStore(join(root, "autonomy.json"));
  const shutdown = new AbortController();
  const outbox = new SeatOutbox({ uncertaintyPath: join(root, "seat-outbox.json") });
  const noModel = async (): Promise<never> => {
    throw new Error("A bound native owner turn must never probe the service model");
  };
  const runner = createConversationRunner({
    shutdown,
    get conversations() {
      return conversations;
    },
    settings: () => settings.load(),
    options: { repoRoot: root, stateDir: root },
    workingDirectory: root,
    seatEventKind: (_id, context, content) =>
      outbox.routesToSeat(content) ? seatEventKindFor(context, true) : undefined,
    seatOutbox: () => outbox,
    durableSession: noModel,
    buildSession: noModel,
    captureEvaluationStart: () => {},
    autonomy,
    syncModel: noModel,
    laneLog: new LaneLog(join(root, "lanes")),
    censusFleets: async () => [],
    deps: { herdrAvailable: () => false } as unknown as CaptainDeps,
    turnSettled: new TurnSettledLog(join(root, "turn-settled.jsonl")),
    goalExecutionReason: () => undefined,
    refuseNativeGoal: () => false,
  });
  const conversations = new ConversationStore(join(root, "conversations"), runner);
  conversations.rememberNativeHead(ID, BINDING);
  const hooks: { beforeServe?: () => Promise<void>; beforeAuthorize?: (check: number) => Promise<void> } = {};
  const service = await createClankieApp({
    settings,
    captain: createStubCaptain({
      serveOperatorConversation: async (request, authority, signal) => {
        await hooks.beforeServe?.();
        let checks = 0;
        const admittedAuthority =
          authority === undefined
            ? undefined
            : {
                ...authority,
                authorize: async () => {
                  checks += 1;
                  await hooks.beforeAuthorize?.(checks);
                  return authority.authorize();
                },
              };
        return conversations.serve(
          request as Parameters<ConversationStore["serve"]>[0],
          admittedAuthority,
          signal,
        );
      },
      invalidateQuestionPrincipal: (id) => conversations.invalidateQuestionPrincipal(id),
    }),
    eventLogPath,
    deviceSessionKey: key,
    clock: () => new Date(now),
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-captain"
        ? { captainId: "fixture-worker", steerSourceLane: "api" }
        : undefined,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-owner"
        ? { operatorId: "fixture-owner" }
        : undefined,
  });
  cleanups.push(async () => {
    shutdown.abort();
    outbox.close();
    autonomy.close();
    await conversations.close();
    service.close();
    rmSync(root, { recursive: true, force: true });
  });
  const dispatch = (request: OperatorConversationServiceRequest, bearer = token) =>
    service.app.request("/operator/v1/dispatch", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  const send = (source = "ios-owner", bearer = token) =>
    dispatch(
      {
        schemaVersion: 1,
        op: "send",
        turn: {
          schemaVersion: 1,
          kind: "message",
          conversationId: ID,
          surfaceClientId: source,
          expectedRevision: conversations.conversation(ID)!.revision,
          message: "Help me debug this owner request.",
        },
      },
      bearer,
    );
  const poll = () => conversations.pollConversationDriver(ID, () => outbox.poll(60000, undefined, BINDING));
  const journal = () => new ConversationJournal(join(root, "conversations")).read(ID);
  const revoke = async () => {
    const response = await service.app.request(`/v1/devices/${DEVICE}/revoke`, {
      method: "POST",
      headers: { authorization: "Bearer fixture-owner" },
    });
    expect(response.status).toBe(200);
  };
  return { service, conversations, outbox, hooks, dispatch, send, poll, journal, revoke };
}

it.each([
  { bearer: "device", principal: { kind: "device", id: DEVICE } },
  { bearer: "operator", principal: { kind: "operator", id: "fixture-owner" } },
] as const)(
  "authenticated $bearer owner reaches the native head as an ordinary turn with one app answer",
  async ({ bearer, principal }) => {
    const f = await fixture();
    const poll = f.poll();
    const response = await f.send("ios-owner", bearer === "operator" ? "fixture-owner" : undefined);
    expect(response.status).toBe(200);
    const accepted = (await response.json()) as { result: { status: string; runId: string } };
    expect(accepted.result.status).toBe("accepted");
    const settled = f.conversations.awaitRunResult(accepted.result.runId);
    const event = OperatorSeatEventSchema.parse((await poll)[0]);
    expect(event).toMatchObject({
      kind: "turn",
      conversationId: ID,
      source: "ios-owner",
      ownerOrigin: { surfaceClientId: "ios-owner", principal },
    });
    expect(event.content).not.toContain("reply_seat_event");
    expect(f.outbox.acknowledge(event.id, BINDING)).toBe(true);
    expect(await settled).toBe(true);
    expect(f.journal().filter((item) => item.type === "turn" && item.phase === "completed")).toMatchObject([
      { runId: accepted.result.runId, deliveryStage: "delivered" },
    ]);
    expect(f.journal().filter((item) => item.type === "message" && item.role === "captain")).toHaveLength(0);
    expect(f.outbox.reply(event.id, "This is not a separate app answer", BINDING)).toBe(false);
    expect(f.journal().filter((item) => item.type === "message" && item.role === "operator")).toMatchObject([
      { text: "Help me debug this owner request.", ownerOrigin: { surfaceClientId: "ios-owner", principal } },
    ]);
    // A normal native answer enters the same app conversation through transcript sync.
    f.conversations.syncHeadTranscript("head-seat", {
      sessionKey: BINDING,
      entries: [
        { type: "message", id: "answer-1", role: "agent", text: "Here is the normal native answer." },
      ],
    });
    // Relay reads use its captain upstream; owner writes use the device route above.
    const replay = await f.dispatch(
      {
        schemaVersion: 1,
        op: "replay",
        replay: { schemaVersion: 1, conversationId: ID, surfaceClientId: "ios-owner" },
      },
      "fixture-captain",
    );
    expect(replay.status).toBe(200);
    const page = (await replay.json()) as {
      result: { status: string; events: { type: string; role?: string; text?: string }[] };
    };
    expect(page.result.status).toBe("page");
    expect(
      f
        .journal()
        .filter(
          (item) =>
            item.type === "message" &&
            item.role === "captain" &&
            item.text === "Here is the normal native answer.",
        ),
    ).toHaveLength(1);
    expect(JSON.stringify(page)).toContain("Here is the normal native answer.");
    expect(f.journal().filter((item) => item.type === "turn" && item.phase === "failed")).toHaveLength(0);
  },
);

it("a worker spoofing the owner surface remains an escalation with its existing reply target", async () => {
  const f = await fixture();
  const poll = f.poll();
  const response = await f.send("ios-owner", "fixture-captain");
  expect(response.status).toBe(200);
  const accepted = (await response.json()) as { result: { runId: string } };
  const settled = f.conversations.awaitRunResult(accepted.result.runId);
  const event = OperatorSeatEventSchema.parse((await poll)[0]);
  expect(event.kind).toBe("escalation");
  expect(event.source).toBe("ios-owner");
  expect(event.ownerOrigin).toBeUndefined();
  expect(f.outbox.reply(event.id, "Worker answer through existing reply", BINDING)).toBe(true);
  expect(await settled).toBe(true);
  const ownerMessages = f.journal().filter((item) => item.type === "message" && item.role === "operator");
  expect(ownerMessages).toHaveLength(1);
  expect(ownerMessages[0]).not.toHaveProperty("ownerOrigin");
  expect(f.journal().filter((item) => item.type === "message" && item.role === "captain")).toMatchObject([
    { text: "Worker answer through existing reply" },
  ]);
});

it("an internal worker message stays a message without owner provenance", async () => {
  const f = await fixture();
  const poll = f.poll();
  const accepted = f.conversations.submitInternal(ID, "Worker finished the assigned check.", "message");
  if (accepted.status !== "accepted") throw new Error("Expected internal message admission");
  const settled = f.conversations.awaitRunResult(accepted.runId);
  const event = OperatorSeatEventSchema.parse((await poll)[0]);
  expect(event.kind).toBe("message");
  expect(event.ownerOrigin).toBeUndefined();
  expect(f.outbox.acknowledge(event.id, BINDING)).toBe(true);
  expect(await settled).toBe(true);
  expect(f.outbox.reply(event.id, "No separate reply", BINDING)).toBe(false);
});

it("revocation after route authentication but before admission prevents journal append and native dispatch", async () => {
  const f = await fixture();
  await f.outbox.poll(0, undefined, BINDING);
  f.hooks.beforeServe = async () => {
    delete f.hooks.beforeServe;
    await f.revoke();
  };
  const response = await f.send();
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: "question_owner_required" });
  expect(await f.outbox.poll(0, undefined, BINDING)).toEqual([]);
  expect(f.journal().filter((item) => item.type === "message" && item.role === "operator")).toHaveLength(0);
});

it("revocation between accepted owner append and native admission prevents dispatch", async () => {
  const f = await fixture();
  await f.outbox.poll(0, undefined, BINDING);
  f.hooks.beforeAuthorize = async (check) => {
    if (check === 2) await f.revoke();
  };
  const response = await f.send();
  expect(response.status).toBe(200);
  const accepted = (await response.json()) as { result: { status: string; runId: string } };
  expect(accepted.result.status).toBe("accepted");
  expect(await f.conversations.awaitRunResult(accepted.result.runId)).toBe(false);
  expect(await f.outbox.poll(0, undefined, BINDING)).toEqual([]);
  expect(f.journal().filter((item) => item.type === "message" && item.role === "operator")).toHaveLength(1);
  expect(f.journal().filter((item) => item.type === "turn" && item.phase === "failed")).toHaveLength(1);
  expect(f.journal().filter((item) => item.type === "turn" && item.phase === "completed")).toHaveLength(0);
});

it("concurrent authenticated owner sends retain a typed revision conflict and one dispatch", async () => {
  const f = await fixture();
  const expectedRevision = f.conversations.conversation(ID)!.revision;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let admittedChecks = 0;
  f.hooks.beforeAuthorize = async (check) => {
    if (check !== 1) return;
    admittedChecks += 1;
    if (admittedChecks === 2) release();
    await gate;
  };
  const poll = f.poll();
  const request = (message: string): OperatorConversationServiceRequest => ({
    schemaVersion: 1,
    op: "send",
    turn: {
      schemaVersion: 1,
      kind: "message",
      conversationId: ID,
      surfaceClientId: "ios-owner",
      expectedRevision,
      message,
    },
  });
  const responses = await Promise.all([
    f.dispatch(request("First simultaneous owner input")),
    f.dispatch(request("Second simultaneous owner input")),
  ]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  const results = await Promise.all(
    responses.map(
      async (response) => (await response.json()) as { result: { status: string; runId?: string } },
    ),
  );
  expect(results.map((item) => item.result.status).sort()).toEqual(["accepted", "revision_conflict"]);
  const accepted = results.find((item) => item.result.status === "accepted")!.result;
  const settled = f.conversations.awaitRunResult(accepted.runId!);
  const event = OperatorSeatEventSchema.parse((await poll)[0]);
  expect(event.kind).toBe("turn");
  expect(f.outbox.acknowledge(event.id, BINDING)).toBe(true);
  expect(await settled).toBe(true);
  expect(await f.outbox.poll(0, undefined, BINDING)).toEqual([]);
  expect(f.journal().filter((item) => item.type === "message" && item.role === "operator")).toHaveLength(1);
});
