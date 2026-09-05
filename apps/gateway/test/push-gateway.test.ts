import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { SUPERVISE_GRANTS } from "@clankie/protocol";
import {
  PublicGatewayTunnelFrameSchema,
  type PublicGatewayTunnelFrame,
} from "@clankie/protocol/public-gateway";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { ApnsResult, ApnsWake } from "../src/apns.ts";
import { createPublicGateway } from "../src/gateway.ts";
import { PushRegistrations } from "../src/push-registrations.ts";

const hostA = "host_A_1234567890";
const hostB = "host_B_1234567890";
const token = "static-host-credential-longer-than-32-characters";
const registration = {
  registrationId: "06480edf-46e9-4f42-a741-d009a7ad684a",
  sequence: 1,
  hostId: hostA,
  deliveryKey: "A".repeat(43),
  deviceToken: "ab".repeat(32),
  environment: "sandbox",
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  let now = Date.now();
  const registrations = new PushRegistrations(":memory:", () => now);
  const send = vi
    .fn<(wake: ApnsWake) => Promise<ApnsResult>>()
    .mockResolvedValue({ status: "sent", apnsId: undefined });
  const gateway = createPublicGateway({
    hostTokens: new Map([
      [hostA, token],
      [hostB, token],
    ]),
    clock: () => now,
    push: { registrations, sender: { send, close: async () => undefined } },
  });
  gateway.server.listen(0, "127.0.0.1");
  await once(gateway.server, "listening");
  const origin = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
  const sockets: WebSocket[] = [];
  cleanups.push(async () => {
    for (const socket of sockets) socket.terminate();
    await gateway.close();
    registrations.close();
  });
  async function host(id: string) {
    const socket = new WebSocket(`${origin.replace("http", "ws")}/gateway/v1/hosts/connect?hostId=${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    sockets.push(socket);
    await once(socket, "open");
    return socket;
  }
  // `null` omits the header entirely; the default keeps every existing caller.
  async function post(body: unknown, clear = false, bearer: string | null | undefined = "device-session") {
    return await fetch(`${origin}/gateway/v1/push/registrations${clear ? "/clear" : ""}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer === undefined || bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
      },
      body: JSON.stringify(body),
    });
  }
  /** Raw body and extra headers, for budget checks that must not be parsed. */
  async function postRaw(
    body: string,
    clear = false,
    bearer: string | null = null,
    headers: Record<string, string> = {},
  ): Promise<number> {
    const response = await fetch(`${origin}/gateway/v1/push/registrations${clear ? "/clear" : ""}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        ...headers,
      },
      body,
    });
    await response.arrayBuffer();
    return response.status;
  }
  return {
    registrations,
    send,
    host,
    origin,
    post,
    postRaw,
    tick: () => {
      now += 2000;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function next(socket: WebSocket): Promise<PublicGatewayTunnelFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("missing gateway frame")), 2000);
    socket.once("message", (raw) => {
      clearTimeout(timer);
      try {
        resolve(PublicGatewayTunnelFrameSchema.parse(JSON.parse(raw.toString())));
      } catch (error) {
        reject(error);
      }
    });
  });
}
function sendFrame(socket: WebSocket, frame: PublicGatewayTunnelFrame) {
  socket.send(JSON.stringify(frame));
}
function respond(
  socket: WebSocket,
  frame: PublicGatewayTunnelFrame,
  status = 200,
  body: unknown = {
    deviceId: "device-1",
    name: "Phone",
    platform: "ios",
    grants: SUPERVISE_GRANTS,
    host: { name: "Host" },
    sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  },
) {
  if (frame.kind !== "request") throw new Error("not a request");
  sendFrame(socket, {
    schemaVersion: 1,
    kind: "response_start",
    requestId: frame.requestId,
    status,
    headers: [],
  });
  sendFrame(socket, {
    schemaVersion: 1,
    kind: "response_chunk",
    requestId: frame.requestId,
    sequence: 0,
    bodyBase64: Buffer.from(JSON.stringify(body)).toString("base64"),
  });
  sendFrame(socket, { schemaVersion: 1, kind: "response_end", requestId: frame.requestId });
}
async function register(context: Awaited<ReturnType<typeof setup>>, socket: WebSocket, body = registration) {
  const frame = next(socket);
  const response = context.post(body);
  respond(socket, await frame);
  return await response;
}
async function wake(socket: WebSocket, binding = registration, deviceId = "device-1") {
  const result = next(socket);
  sendFrame(socket, {
    schemaVersion: 1,
    kind: "push_wake",
    wakeId: randomUUID(),
    deviceId,
    registrationId: binding.registrationId,
    sequence: binding.sequence,
    conversationId: "conv-1",
  });
  return await result;
}

describe("gateway push authorization", () => {
  it("verifies the device over the existing tunnel without sending the delivery key or APNs token to its host", async () => {
    const ctx = await setup();
    const host = await ctx.host(hostA);
    const frame = next(host);
    const response = ctx.post(registration);
    const probe = await frame;
    expect(probe).toMatchObject({
      kind: "request",
      path: "/v1/devices/self",
      method: "GET",
      target: "control",
      headers: [{ name: "authorization", value: "Bearer device-session" }],
    });
    expect(JSON.stringify(probe)).not.toContain(registration.deliveryKey);
    expect(JSON.stringify(probe)).not.toContain(registration.deviceToken);
    respond(host, probe);
    expect(await (await response).json()).toEqual({
      registrationId: registration.registrationId,
      sequence: 1,
      deviceId: "device-1",
    });
    expect(await wake(host)).toMatchObject({ status: "sent" });
    expect(ctx.send.mock.calls[0]?.[0]).toMatchObject({
      deviceToken: registration.deviceToken,
      hostId: hostA,
      conversationId: "conv-1",
    });
    expect(await wake(host, registration, "device-2")).toMatchObject({ status: "superseded" });
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });

  it("refuses invalid or revoked sessions and malformed/oversized host claims", async () => {
    const ctx = await setup();
    const host = await ctx.host(hostA);
    expect((await ctx.post(registration, false, "")).status).toBe(401);
    for (const [status, body, expected] of [
      [401, {}, 401],
      [200, {}, 502],
      [200, "x".repeat(5000), 503],
    ] as const) {
      const frame = next(host);
      const response = ctx.post(registration);
      const probe = await frame;
      if (typeof body === "string") {
        // The gateway cancels on the oversized chunk, so no response_end follows it.
        if (probe.kind !== "request") throw new Error("not a request");
        sendFrame(host, {
          schemaVersion: 1,
          kind: "response_start",
          requestId: probe.requestId,
          status,
          headers: [],
        });
        sendFrame(host, {
          schemaVersion: 1,
          kind: "response_chunk",
          requestId: probe.requestId,
          sequence: 0,
          bodyBase64: Buffer.from(body).toString("base64"),
        });
        expect(await next(host)).toMatchObject({ kind: "cancel" });
      } else respond(host, probe, status, body);
      expect((await response).status).toBe(expected);
    }
    expect(ctx.registrations.delivery(hostA, "device-1", registration)).toBe("not_registered");
    expect(ctx.send).not.toHaveBeenCalled();
  });

  it("moves a device with its key and refuses the former host, forged keys and old versions", async () => {
    const ctx = await setup();
    const a = await ctx.host(hostA);
    const b = await ctx.host(hostB);
    expect((await register(ctx, a)).status).toBe(200);
    const moved = { ...registration, hostId: hostB, sequence: 2 };
    expect((await register(ctx, b, moved)).status).toBe(200);
    expect(await wake(a)).toMatchObject({ status: "superseded" });
    expect(await wake(b, moved)).toMatchObject({ status: "sent" });
    expect(
      (await register(ctx, a, { ...registration, sequence: 3, deliveryKey: "B".repeat(43) })).status,
    ).toBe(409);
    expect((await register(ctx, a)).status).toBe(409);
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });

  it("clears an existing registration offline, but requires authenticated allocation for an initial tombstone", async () => {
    const ctx = await setup();
    const a = await ctx.host(hostA);
    const clear = {
      registrationId: registration.registrationId,
      sequence: 2,
      deliveryKey: registration.deliveryKey,
    };
    expect((await ctx.post(clear, true, "")).status).toBe(401);
    const frame = next(a);
    const cleared = ctx.post({ ...clear, hostId: hostA }, true);
    respond(a, await frame);
    expect((await cleared).status).toBe(200);
    expect((await register(ctx, a)).status).toBe(409);
    const live = { ...registration, sequence: 3 };
    expect((await register(ctx, a, live)).status).toBe(200);
    a.close();
    await once(a, "close");
    expect((await ctx.post({ ...clear, sequence: 4 }, true, "")).status).toBe(200);
    expect(ctx.registrations.delivery(hostA, "device-1", live)).toBe("not_registered");
    // A wrong key without device authentication is answered like an unknown
    // reference, so the route cannot be used to discover which ones exist. The
    // conflict is still reported to a caller that authenticates — below.
    expect((await ctx.post({ ...clear, sequence: 5, deliveryKey: "B".repeat(43) }, true, "")).status).toBe(
      401,
    );
  });

  it("stops an unauthenticated burst before it reaches a host frame or the registration table", async () => {
    const ctx = await setup();
    const a = await ctx.host(hostA);
    let hostFrames = 0;
    a.on("message", (raw) => {
      if (PublicGatewayTunnelFrameSchema.parse(JSON.parse(raw.toString())).kind === "request")
        hostFrames += 1;
    });
    // The peer is charged before the body is even parsed, so unparseable junk
    // spends the same budget a well-formed claim would.
    const statuses: number[] = [];
    for (let index = 0; index < 40; index += 1) statuses.push(await ctx.postRaw("not json", false, "junk"));
    expect(statuses.filter((status) => status === 400).length).toBe(30);
    expect(statuses.filter((status) => status === 429).length).toBe(10);
    expect(statuses.at(-1)).toBe(429);

    // With the bucket spent, a well-formed claim naming a live host is refused
    // before that host is asked anything.
    expect((await ctx.post({ ...registration, deliveryKey: "Q".repeat(43) }, false, "junk")).status).toBe(
      429,
    );
    expect(hostFrames).toBe(0);
    expect(ctx.registrations.delivery(hostA, "device-1", registration)).toBe("not_registered");
  });

  it("meters the connecting socket, not a forwarding header the caller writes", async () => {
    const ctx = await setup();
    await ctx.host(hostA);
    const statuses: number[] = [];
    for (let index = 0; index < 40; index += 1) {
      // Every request claims a different origin; none of them is believed.
      statuses.push(
        await ctx.postRaw("not json", false, "junk", {
          "x-forwarded-for": `203.0.113.${String(index % 250)}`,
          forwarded: `for=198.51.100.${String(index % 250)}`,
          "x-real-ip": `192.0.2.${String(index % 250)}`,
        }),
      );
    }
    expect(statuses.filter((status) => status === 429).length).toBe(10);
    expect(statuses.at(-1)).toBe(429);
  });

  it("leaves the account wake allowance intact after an unauthenticated burst", async () => {
    const ctx = await setup();
    const a = await ctx.host(hostA);
    expect((await register(ctx, a)).status).toBe(200);
    for (let index = 0; index < 40; index += 1) await ctx.postRaw("not json", false, "junk");
    // The junk was charged to the peer, so the account can still be woken.
    expect(await wake(a)).toMatchObject({ status: "sent" });
    expect(ctx.send).toHaveBeenCalledTimes(1);
  });

  it("credits a denied caller for the time it waited, so sub-second retries still earn a token", async () => {
    const ctx = await setup();
    await ctx.host(hostA);
    // Spend the peer bucket, then confirm it is empty.
    for (let index = 0; index < 30; index += 1)
      expect(await ctx.postRaw("not json", false, "junk")).toBe(400);
    expect(await ctx.postRaw("not json", false, "junk")).toBe(429);

    // Knock four times a second apart from nothing: each denial must keep the
    // quarter-token it accrued rather than resetting to empty.
    const denied: number[] = [];
    for (let step = 0; step < 3; step += 1) {
      ctx.advance(250);
      denied.push(await ctx.postRaw("not json", false, "junk"));
    }
    expect(denied).toEqual([429, 429, 429]);

    // One cumulative second after the drain, a whole token exists again.
    ctx.advance(250);
    expect(await ctx.postRaw("not json", false, "junk")).toBe(400);
    // And it was exactly one: the next attempt is refused again.
    expect(await ctx.postRaw("not json", false, "junk")).toBe(429);
  });

  it("credits a denied account the same way, through the shared bucket", async () => {
    const ctx = await setup();
    const a = await ctx.host(hostA);
    expect((await register(ctx, a)).status).toBe(200);
    // The registration already spent one; drain the rest of the account bucket.
    for (let index = 0; index < 59; index += 1) expect(await wake(a)).toMatchObject({ status: "sent" });
    expect(await wake(a)).toMatchObject({ status: "throttled" });

    for (let step = 0; step < 3; step += 1) {
      ctx.advance(250);
      expect(await wake(a)).toMatchObject({ status: "throttled" });
    }

    ctx.advance(250);
    expect(await wake(a)).toMatchObject({ status: "sent" });
    expect(await wake(a)).toMatchObject({ status: "throttled" });
  });

  it("answers an unknown reference and a wrong key identically without device authentication", async () => {
    const ctx = await setup();
    const a = await ctx.host(hostA);
    expect((await register(ctx, a)).status).toBe(200);
    const unknown = await ctx.post(
      { registrationId: "11111111-2222-4333-8444-555555555555", sequence: 1, deliveryKey: "C".repeat(43) },
      true,
      null,
    );
    const wrongKey = await ctx.post(
      { registrationId: registration.registrationId, sequence: 9, deliveryKey: "Z".repeat(43) },
      true,
      null,
    );
    expect(wrongKey.status).toBe(unknown.status);
    expect(await wrongKey.json()).toEqual(await unknown.json());
    expect(unknown.status).toBe(401);

    // The correct key still clears offline, and a conflict stays actionable for
    // a caller that actually authenticates.
    a.close();
    await once(a, "close");
    expect(
      (
        await ctx.post(
          {
            registrationId: registration.registrationId,
            sequence: 2,
            deliveryKey: registration.deliveryKey,
          },
          true,
          null,
        )
      ).status,
    ).toBe(200);
    const b = await ctx.host(hostB);
    const frame = next(b);
    const conflict = ctx.post(
      {
        registrationId: registration.registrationId,
        sequence: 3,
        deliveryKey: "Z".repeat(43),
        hostId: hostB,
      },
      true,
    );
    respond(b, await frame);
    expect((await conflict).status).toBe(409);
    expect(await (await conflict).json()).toEqual({ error: "mismatched_delivery_key" });
  });

  it("preserves registrations on local refusals, Apple 400, missing/old 410 timestamp and delayed 410 for an old version", async () => {
    const ctx = await setup();
    const a = await ctx.host(hostA);
    expect((await register(ctx, a)).status).toBe(200);
    for (const result of [
      { status: "refused", reason: "BadDeviceToken" },
      { status: "rejected", httpStatus: 400, reason: "BadDeviceToken" },
      { status: "unregistered", reason: "Unregistered", timestampMs: undefined },
      { status: "unregistered", reason: "Unregistered", timestampMs: 1 },
    ] satisfies ApnsResult[]) {
      ctx.send.mockResolvedValueOnce(result);
      await wake(a);
      expect(ctx.registrations.delivery(hostA, "device-1", registration)).toMatchObject({ sequence: 1 });
    }
    let finish!: (result: ApnsResult) => void;
    const started = new Promise<void>((resolve) =>
      ctx.send.mockImplementationOnce(async () => {
        resolve();
        return await new Promise<ApnsResult>((r) => {
          finish = r;
        });
      }),
    );
    const oldWake = wake(a);
    await started;
    ctx.tick();
    // Register directly here so the host socket's next message remains the pending wake result.
    const moved = {
      ...registration,
      environment: "sandbox" as const,
      sequence: 2,
      deviceToken: "cd".repeat(32),
    };
    ctx.registrations.register(moved, "device-1", `static:${hostA}`);
    finish({ status: "unregistered", reason: "Unregistered", timestampMs: Date.now() + 30_000 });
    expect(await oldWake).toMatchObject({ status: "unavailable" });
    expect(ctx.registrations.delivery(hostA, "device-1", moved)).toMatchObject({ sequence: 2 });
    ctx.send.mockResolvedValueOnce({
      status: "unregistered",
      reason: "Unregistered",
      timestampMs: Date.now() + 30_000,
    });
    expect(await wake(a, moved)).toMatchObject({ status: "unregistered" });
    expect(ctx.registrations.delivery(hostA, "device-1", moved)).toBe("not_registered");
  });

  it("keeps the account budget across socket reconnect and bounds sends", async () => {
    const ctx = await setup();
    let a = await ctx.host(hostA);
    expect((await register(ctx, a)).status).toBe(200);
    for (let i = 0; i < 59; i += 1) expect(await wake(a)).toMatchObject({ status: "sent" });
    expect(await wake(a)).toMatchObject({ status: "throttled" });
    a.close();
    await once(a, "close");
    a = await ctx.host(hostA);
    expect(await wake(a)).toMatchObject({ status: "throttled" });
    expect(ctx.send).toHaveBeenCalledTimes(59);
  });
});
