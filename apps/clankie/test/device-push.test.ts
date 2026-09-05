import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SUPERVISE_GRANTS, type DomainEvent } from "@clankie/protocol";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createClankieApp, type TrustedOperatorIdentity } from "../src/app.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createPushDispatcher, type PushWakeRequest, type PushWakeStatus } from "../src/push.ts";

const tempDirs: string[] = [];
const DEVICE_KEY = Uint8Array.from(Buffer.alloc(32, 7));
const OPERATOR = { authorization: "Bearer operator-secret" };
const IOS = { name: "James iPhone", platform: "ios" } as const;
const REGISTRATION = "6f1f0f9a-4e7c-4a4f-9c1a-2b6d5f0a1c33";
const OTHER_REGISTRATION = "9c8f3a21-5d6e-4b7c-9a8b-1f2e3d4c5b6a";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function operator(request: Request): Promise<TrustedOperatorIdentity | undefined> {
  return Promise.resolve(
    request.headers.get("authorization") === "Bearer operator-secret"
      ? { operatorId: "operator-james" }
      : undefined,
  );
}

interface EventLog {
  path: string;
  readAll(): DomainEvent[];
}

async function makeStore(): Promise<EventLog> {
  const root = await mkdtemp(join(tmpdir(), "clankie-device-push-"));
  tempDirs.push(root);
  const path = join(root, "events.jsonl");
  return {
    path,
    readAll() {
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        return [];
      }
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as DomainEvent);
    },
  };
}

/** Records what the connector would have put on the wire, and answers with a script. */
function fakeGateway(statuses: PushWakeStatus[] = []) {
  const sent: PushWakeRequest[] = [];
  const queue = [...statuses];
  return {
    sent,
    sendPushWake(request: PushWakeRequest): Promise<PushWakeStatus> {
      sent.push(request);
      return Promise.resolve(queue.shift() ?? "sent");
    },
  };
}

/**
 * One service instance and the conversation store its captain owns. The app
 * subscribes through the port, so a store built anywhere else is a different
 * captain's and must not reach this app's devices.
 */
async function makeApp(
  store: EventLog,
  pushWake?: { sendPushWake(request: PushWakeRequest): Promise<PushWakeStatus> },
): Promise<{ app: Hono; conversations: ConversationStore; close: () => void }> {
  const conversations = await makeConversations();
  const clankie = await createClankieApp({
    captain: createStubCaptain({
      observeDurableMessages: (listener) => conversations.observeDurableMessages(listener),
    }),
    eventLogPath: store.path,
    authenticateOperator: operator,
    hostDisplayName: "Test Mac",
    deviceSessionKey: DEVICE_KEY,
    ...(pushWake === undefined ? {} : { pushWake }),
  });
  return { app: clankie.app, conversations, close: () => clankie.close() };
}

async function pairDevice(app: Hono): Promise<{ deviceId: string; token: string }> {
  const offerResponse = await app.request("/v1/pairing/offer", {
    method: "POST",
    headers: { ...OPERATOR, "content-type": "application/json" },
    body: "{}",
  });
  const offer = (await offerResponse.json()) as { deepLink: string };
  const offerSecret = new URL(offer.deepLink).searchParams.get("offer");
  const redeemResponse = await app.request("/v1/pairing/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offerSecret, device: IOS }),
  });
  const redeemed = (await redeemResponse.json()) as { deviceId: string; completionToken: string };
  const completeResponse = await app.request("/v1/pairing/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ completionToken: redeemed.completionToken, acceptedGrants: SUPERVISE_GRANTS }),
  });
  const completed = (await completeResponse.json()) as { deviceToken: string };
  return { deviceId: redeemed.deviceId, token: completed.deviceToken };
}

async function setPush(
  app: Hono,
  token: string,
  body: { registrationId: string; sequence: number; enabled: boolean },
): Promise<Response> {
  return app.request("/v1/devices/self/push", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/devices/self/push", () => {
  it("records the reference and its version, and nothing else", async () => {
    const store = await makeStore();
    const { app, close } = await makeApp(store);
    const { deviceId, token } = await pairDevice(app);

    const response = await setPush(app, token, { registrationId: REGISTRATION, sequence: 4, enabled: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: true, registrationId: REGISTRATION, sequence: 4 });

    const event = store.readAll().find((entry) => entry.type === "device.push.changed");
    expect(event?.data).toEqual({
      schemaVersion: 1,
      deviceId,
      registrationId: REGISTRATION,
      sequence: 4,
      enabled: true,
    });
    // Privacy: the durable log carries no token, key, or anything device-secret.
    const log = JSON.stringify(store.readAll());
    expect(log).not.toContain("deviceToken");
    expect(log).not.toContain("deliveryKey");
    expect(log.toLowerCase()).not.toContain("apns");
    close();
  });

  it("refuses an unauthenticated caller, a malformed body, and a revoked device", async () => {
    const store = await makeStore();
    const { app, close } = await makeApp(store);
    const { deviceId, token } = await pairDevice(app);

    expect(
      (
        await app.request("/v1/devices/self/push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ registrationId: REGISTRATION, sequence: 1, enabled: true }),
        })
      ).status,
    ).toBe(401);
    expect(
      (await setPush(app, token, { registrationId: "not-a-uuid", sequence: 1, enabled: true })).status,
    ).toBe(400);

    await app.request(`/v1/devices/${deviceId}/revoke`, { method: "POST", headers: OPERATOR });
    expect(
      (await setPush(app, token, { registrationId: REGISTRATION, sequence: 1, enabled: true })).status,
    ).toBe(401);
    expect(store.readAll().some((entry) => entry.type === "device.push.changed")).toBe(false);
    close();
  });

  it("orders by version: a retry is idempotent, older is stale, and a reused version conflicts", async () => {
    const store = await makeStore();
    const { app, close } = await makeApp(store);
    const { token } = await pairDevice(app);

    expect(
      (await setPush(app, token, { registrationId: REGISTRATION, sequence: 7, enabled: true })).status,
    ).toBe(200);
    // Same version, same registration: the app retrying its own request.
    expect(
      (await setPush(app, token, { registrationId: REGISTRATION, sequence: 7, enabled: true })).status,
    ).toBe(200);
    expect(store.readAll().filter((entry) => entry.type === "device.push.changed")).toHaveLength(1);

    const stale = await setPush(app, token, { registrationId: REGISTRATION, sequence: 6, enabled: true });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "stale_push_registration" });

    const conflict = await setPush(app, token, {
      registrationId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      sequence: 7,
      enabled: true,
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "conflicting_push_registration" });
    close();
  });

  it("survives a restart: the binding is replayed from the log", async () => {
    const store = await makeStore();
    const first = await makeApp(store);
    const { deviceId, token } = await pairDevice(first.app);
    await setPush(first.app, token, { registrationId: REGISTRATION, sequence: 2, enabled: true });
    first.close();

    const gateway = fakeGateway();
    const restarted = await makeApp(store, gateway);
    // The operator listing proves the projection rebuilt; the wake proves the
    // binding did, since a wake carries the replayed registration and version.
    const listResponse = await restarted.app.request("/v1/devices", { headers: OPERATOR });
    const listed = (await listResponse.json()) as { deviceId: string }[];
    expect(listed.map((device) => device.deviceId)).toContain(deviceId);

    const { conversations } = restarted;
    conversations.publishHeadEvent({ type: "message", role: "captain", text: "back up", streaming: false });
    await settle(gateway.sent);
    expect(gateway.sent[0]).toMatchObject({ deviceId, registrationId: REGISTRATION, sequence: 2 });
    restarted.close();
  });

  it("orders the request after a disable against the disabled version, not a clean slate", async () => {
    const store = await makeStore();
    const { app, close } = await makeApp(store);
    const { token } = await pairDevice(app);

    expect(
      (await setPush(app, token, { registrationId: REGISTRATION, sequence: 5, enabled: true })).status,
    ).toBe(200);
    // The guard while a binding is live, so the disabled case is compared to it.
    expect(
      (await setPush(app, token, { registrationId: REGISTRATION, sequence: 3, enabled: true })).status,
    ).toBe(409);
    expect(
      (await setPush(app, token, { registrationId: REGISTRATION, sequence: 6, enabled: false })).status,
    ).toBe(200);

    // Disabling used to drop the binding, which left this identical request
    // with nothing to be ordered against and restored delivery at version 3.
    const replayed = await setPush(app, token, { registrationId: REGISTRATION, sequence: 3, enabled: true });
    expect(replayed.status).toBe(409);
    expect(await replayed.json()).toEqual({ error: "stale_push_registration" });
    // A different registration at an older version is refused for the same reason.
    expect(
      (await setPush(app, token, { registrationId: OTHER_REGISTRATION, sequence: 1, enabled: true })).status,
    ).toBe(409);

    const written = store.readAll().filter((entry) => entry.type === "device.push.changed");
    expect(written.map((entry) => (entry.data as { sequence: number }).sequence)).toEqual([5, 6]);
    close();
  });

  it("refuses an equal version that flips delivery on or off", async () => {
    const store = await makeStore();
    const { app, close } = await makeApp(store);
    const { token } = await pairDevice(app);

    await setPush(app, token, { registrationId: REGISTRATION, sequence: 4, enabled: true });
    // Identical restatement is the app retrying itself: accepted, nothing written.
    const retry = await setPush(app, token, { registrationId: REGISTRATION, sequence: 4, enabled: true });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ registrationId: REGISTRATION, sequence: 4, enabled: true });

    const flipped = await setPush(app, token, { registrationId: REGISTRATION, sequence: 4, enabled: false });
    expect(flipped.status).toBe(409);
    expect(await flipped.json()).toEqual({ error: "conflicting_push_registration" });

    expect(store.readAll().filter((entry) => entry.type === "device.push.changed")).toHaveLength(1);
    close();
  });

  it("does not let a later request restore the version the gateway invalidated", async () => {
    const store = await makeStore();
    const gateway = fakeGateway(["unregistered"]);
    const { app, conversations, close } = await makeApp(store, gateway);
    const { deviceId, token } = await pairDevice(app);
    await setPush(app, token, { registrationId: REGISTRATION, sequence: 7, enabled: true });

    conversations.publishHeadEvent({ type: "message", role: "captain", text: "hello", streaming: false });
    await settle(gateway.sent);
    await until(async () => (await listedPush(app, deviceId))?.enabled === false);

    // The gateway recorded `enabled: false` at version 7. The app asking for
    // version 7 back is two states claiming one version.
    const restored = await setPush(app, token, { registrationId: REGISTRATION, sequence: 7, enabled: true });
    expect(restored.status).toBe(409);
    expect(await listedPush(app, deviceId)).toEqual({
      registrationId: REGISTRATION,
      sequence: 7,
      enabled: false,
    });
    // A newer version is how the app comes back.
    expect(
      (await setPush(app, token, { registrationId: OTHER_REGISTRATION, sequence: 8, enabled: true })).status,
    ).toBe(200);
    close();
  });

  it("does not apply a gateway clear to a device revoked while the wake was in flight", async () => {
    const store = await makeStore();
    let revoke: (() => Promise<unknown>) | undefined;
    const gateway = {
      sent: [] as PushWakeRequest[],
      async sendPushWake(request: PushWakeRequest): Promise<PushWakeStatus> {
        gateway.sent.push(request);
        // The operator revokes between the send and its acknowledgement.
        await revoke?.();
        return "unregistered";
      },
    };
    const { app, conversations, close } = await makeApp(store, gateway);
    const { deviceId, token } = await pairDevice(app);
    await setPush(app, token, { registrationId: REGISTRATION, sequence: 1, enabled: true });
    revoke = async () =>
      await app.request(`/v1/devices/${deviceId}/revoke`, { method: "POST", headers: OPERATOR });

    conversations.publishHeadEvent({ type: "message", role: "captain", text: "hello", streaming: false });
    await settle(gateway.sent);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // The clear is skipped rather than throwing a push change at a revoked record.
    expect(store.readAll().filter((entry) => entry.type === "device.push.changed")).toHaveLength(1);
    const listed = await listedDevice(app, deviceId);
    expect(listed?.status).toBe("revoked");
    close();
  });
});

describe("one service instance hears only its own captain", () => {
  it("does not wake another instance's devices, and stops on close", async () => {
    const first = await makeStore();
    const second = await makeStore();
    const a = fakeGateway();
    const b = fakeGateway();
    const one = await makeApp(first, a);
    const two = await makeApp(second, b);
    for (const [instance, gateway] of [
      [one, a],
      [two, b],
    ] as const) {
      const { token } = await pairDevice(instance.app);
      await setPush(instance.app, token, { registrationId: REGISTRATION, sequence: 1, enabled: true });
      expect(gateway.sent).toEqual([]);
    }

    one.conversations.publishHeadEvent({ type: "message", role: "captain", text: "mine", streaming: false });
    await settle(a.sent);
    expect(a.sent).toHaveLength(1);
    // A module-wide bus woke both; through the port, the other instance's
    // devices never hear a conversation they cannot open.
    expect(b.sent).toEqual([]);

    one.close();
    a.sent.length = 0;
    one.conversations.publishHeadEvent({
      type: "message",
      role: "captain",
      text: "after close",
      streaming: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 2_400));
    expect(a.sent).toEqual([]);
    two.close();
  });
});

/** A real store, so the trigger under test is the durable append itself. */
async function makeConversations(): Promise<ConversationStore> {
  const root = await mkdtemp(join(tmpdir(), "clankie-push-conversations-"));
  tempDirs.push(root);
  return new ConversationStore(root, async () => Promise.resolve());
}

/** The operator listing's view of one device, which is what the CLI will show. */
async function listedDevice(
  app: Hono,
  deviceId: string,
): Promise<
  { status: string; push?: { registrationId: string; sequence: number; enabled: boolean } } | undefined
> {
  const response = await app.request("/v1/devices", { headers: OPERATOR });
  const listed = (await response.json()) as {
    deviceId: string;
    status: string;
    push?: { registrationId: string; sequence: number; enabled: boolean };
  }[];
  return listed.find((device) => device.deviceId === deviceId);
}

async function listedPush(
  app: Hono,
  deviceId: string,
): Promise<{ registrationId: string; sequence: number; enabled: boolean } | undefined> {
  return (await listedDevice(app, deviceId))?.push;
}

/** Polls a condition rather than sleeping past an unknown settle time. */
async function until(check: () => Promise<boolean>, attempts = 40): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition never held");
}

/** Waits out the dispatcher's coalescing window plus its send. */
async function settle(sent: unknown[], attempts = 40): Promise<void> {
  for (let attempt = 0; attempt < attempts && sent.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("push delivery of a message that is already written", () => {
  it("wakes a registered device for a live captain message, once per burst", async () => {
    const store = await makeStore();
    const gateway = fakeGateway();
    const { app, conversations, close } = await makeApp(store, gateway);
    const { deviceId, token } = await pairDevice(app);
    await setPush(app, token, { registrationId: REGISTRATION, sequence: 1, enabled: true });

    conversations.publishHeadEvent({ type: "message", role: "captain", text: "one", streaming: false });
    conversations.publishHeadEvent({ type: "message", role: "captain", text: "two", streaming: false });
    conversations.publishHeadEvent({ type: "message", role: "captain", text: "three", streaming: false });
    await settle(gateway.sent);

    expect(gateway.sent).toHaveLength(1);
    expect(gateway.sent[0]).toMatchObject({ deviceId, registrationId: REGISTRATION, sequence: 1 });
    expect(gateway.sent[0]?.conversationId).toBe(conversations.defaultGlobalConversationId());
    // Metadata only: a wake names ids and a version, never words.
    expect(JSON.stringify(gateway.sent)).not.toContain("one");
    close();
  });

  it("does not wake for the operator's own message or for imported history", async () => {
    const store = await makeStore();
    const gateway = fakeGateway();
    const { app, conversations, close } = await makeApp(store, gateway);
    const { token } = await pairDevice(app);
    await setPush(app, token, { registrationId: REGISTRATION, sequence: 1, enabled: true });

    conversations.publishHeadEvent({ type: "message", role: "operator", text: "mine", streaming: false });
    // A folded Herdr transcript replays history: every entry carries its own
    // occurredAt, and none of it is news.
    conversations.syncSeatTranscript("seat-1", {
      sessionKey: "session-1",
      entries: [
        {
          id: "entry-1",
          type: "message",
          role: "agent",
          text: "old work",
          occurredAt: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "entry-2",
          type: "message",
          role: "agent",
          text: "older still",
          occurredAt: "2026-08-01T00:01:00.000Z",
        },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(gateway.sent).toEqual([]);
    close();
  });
});

describe("the push dispatcher", () => {
  /** What crosses to the gateway: the version, never the state. */
  const binding = { registrationId: REGISTRATION, sequence: 3 };
  const registration = { ...binding, enabled: true };
  const device = {
    deviceId: "device-1",
    name: "iPhone",
    platform: "ios",
    status: "active",
    grants: { ...SUPERVISE_GRANTS, chat: true },
    offerId: "offer-1",
    mintedBy: "operator-james",
    createdAt: "2026-09-01T00:00:00.000Z",
    pendingExpiresAt: "2026-09-01T00:05:00.000Z",
    activatedAt: "2026-09-01T00:01:00.000Z",
    push: registration,
  } as const;

  function dispatcherFor(
    records: Record<string, unknown>[],
    statuses: PushWakeStatus[] = [],
  ): {
    dispatcher: ReturnType<typeof createPushDispatcher>;
    sent: PushWakeRequest[];
    cleared: { deviceId: string; binding: unknown }[];
  } {
    const gateway = fakeGateway(statuses);
    const cleared: { deviceId: string; binding: unknown }[] = [];
    const dispatcher = createPushDispatcher({
      devices: () => records as never,
      sender: gateway,
      clearBinding: (deviceId, cleanup) => {
        cleared.push({ deviceId, binding: cleanup });
        return Promise.resolve();
      },
      coalesceMs: 0,
      uuid: () => "9d4f4a2c-1c0f-4a0e-9a49-6a2c4a4f0f11",
    });
    return { dispatcher, sent: gateway.sent, cleared };
  }

  it("skips a revoked device and one without the chat grant", async () => {
    const revoked = { ...device, deviceId: "device-revoked", status: "revoked" };
    const noChat = { ...device, deviceId: "device-no-chat", grants: { ...device.grants, chat: false } };
    const unregistered = { ...device, deviceId: "device-unregistered", push: undefined };
    const { dispatcher, sent } = dispatcherFor([revoked, noChat, unregistered]);

    dispatcher.notify("conv-1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toEqual([]);
    dispatcher.close();
  });

  it("stops sending as soon as the device is revoked mid-window", async () => {
    const records: Record<string, unknown>[] = [{ ...device }];
    const { dispatcher, sent } = dispatcherFor(records);

    dispatcher.notify("conv-1");
    records[0] = { ...device, status: "revoked" };
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toEqual([]);
    dispatcher.close();
  });

  it("clears a binding the gateway no longer honours, but only that exact version", async () => {
    const records: Record<string, unknown>[] = [{ ...device }];
    const { dispatcher, sent, cleared } = dispatcherFor(records, ["unregistered"]);

    dispatcher.notify("conv-1");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toHaveLength(1);
    expect(cleared).toEqual([{ deviceId: "device-1", binding }]);
    dispatcher.close();
  });

  it("leaves the binding alone when the gateway is unavailable or throttling", async () => {
    const records: Record<string, unknown>[] = [{ ...device }];
    const { dispatcher, cleared } = dispatcherFor(records, ["unavailable", "throttled"]);

    dispatcher.notify("conv-1");
    await new Promise((resolve) => setTimeout(resolve, 30));
    dispatcher.notify("conv-2");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(cleared).toEqual([]);
    dispatcher.close();
  });

  it("bounds how many wakes can be pending at once", async () => {
    const records: Record<string, unknown>[] = [{ ...device }];
    const gateway = fakeGateway();
    const dispatcher = createPushDispatcher({
      devices: () => records as never,
      sender: gateway,
      clearBinding: () => Promise.resolve(),
      coalesceMs: 50,
      maxPending: 2,
    });

    dispatcher.notify("conv-1");
    dispatcher.notify("conv-2");
    dispatcher.notify("conv-3");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(gateway.sent.map((request) => request.conversationId)).toEqual(["conv-1", "conv-2"]);
    dispatcher.close();
  });
});
