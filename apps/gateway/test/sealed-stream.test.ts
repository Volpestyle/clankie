import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  OPERATOR_VOICE_CALL_PATH,
  PairingCompleteResponseSchema,
  PairingOfferWireSchema,
  PairingRedeemResponseSchema,
} from "@clankie/protocol";
import {
  GATEWAY_STREAM_RECORD_BINARY,
  GATEWAY_STREAM_RECORD_START,
  GATEWAY_STREAM_RECORD_TEXT,
} from "@clankie/protocol/gateway-encryption";
import {
  PUBLIC_GATEWAY_HOST_CONNECT_PATH,
  PUBLIC_GATEWAY_SCHEMA_VERSION,
  PUBLIC_GATEWAY_STREAMS_HEADER,
  PublicGatewayTunnelFrameSchema,
  type PublicGatewayTunnelFrame,
} from "@clankie/protocol/public-gateway";
import { createGatewayStreamOpening } from "../../../packages/api-client/src/gateway-encryption.ts";
import { ControlPlaneDeviceAuthorizer } from "../../../apps/relay/src/device-auth.ts";
import { createVoiceCallUpgrade } from "../../../apps/relay/src/voice-call.ts";
import { createClankieApp } from "../../../apps/clankie/src/app.ts";
import { createStubCaptain } from "../../../apps/clankie/src/captain/port.ts";
import {
  openGatewayBytes,
  openGatewayValue,
  sealGatewayBytes,
  sealGatewayValue,
} from "../../../apps/clankie/src/gateway-encryption.ts";
import { PublicGatewayConnector } from "../../../apps/clankie/src/public-gateway-connector.ts";
import { createPublicGateway, type PublicGatewayLogger } from "../src/gateway.ts";

// A phone's call through the real gateway (clankie ADR 0289): the phone's own
// opening and sealed records over a real socket to the gateway, the real Mac
// connector and encryption host behind it, and the relay's real call route.
// Only the service's end of the call is scripted.

const HOST_ID = "mac_stream_12345678";
const HOST_TOKEN = "gateway-host-token-that-is-longer-than-thirty-two-characters";
const OWNER = "stream-owner-token";
const CAPTAIN = "stream-captain-token";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function until(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The challenge route answers once the Mac's tunnel is up. */
async function tunnelUp(gateway: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while ((await fetch(`${gateway}/h/${HOST_ID}/v1/gateway/challenge`)).status !== 200) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the Mac's tunnel");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Everything the gateway logged, as one string a secret must not appear in. */
function recordingLogger(): PublicGatewayLogger & { readonly text: () => string } {
  const lines: string[] = [];
  const log = (fields: Readonly<Record<string, unknown>>, message: string) =>
    lines.push(`${message} ${JSON.stringify(fields)}`);
  return { info: log, warn: log, text: () => lines.join("\n") };
}

async function startGateway() {
  const logger = recordingLogger();
  const gateway = createPublicGateway({ hostTokens: new Map([[HOST_ID, HOST_TOKEN]]), logger });
  cleanups.push(() => gateway.close());
  const origin = await listen(gateway.server);
  return { gateway, origin, logger };
}

async function stack(options: { carriesCalls?: boolean } = {}) {
  const { origin: gateway, logger } = await startGateway();
  const app = await createClankieApp({
    captain: createStubCaptain(),
    deviceSessionKey: randomBytes(32),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${OWNER}` ? { operatorId: "owner" } : undefined,
  });
  cleanups.push(() => app.close());
  const control = await listen(
    createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers))
        if (typeof value === "string") headers.set(name, value);
      const body = Buffer.concat(chunks);
      const result = await app.app.fetch(
        new Request(`http://${request.headers.host}${request.url}`, {
          method: request.method ?? "GET",
          headers,
          ...(body.length ? { body } : {}),
        }),
      );
      response.statusCode = result.status;
      result.headers.forEach((value, name) => response.setHeader(name, value));
      response.end(Buffer.from(await result.arrayBuffer()));
    }),
  );

  // The service's end of the call: says it is listening, then echoes each audio frame.
  const heard: Buffer[] = [];
  let hungUp = 0;
  const serviceSockets = new WebSocketServer({ noServer: true });
  const service = createServer();
  service.on("upgrade", (request, socket, head) => {
    if (request.url !== OPERATOR_VOICE_CALL_PATH || request.headers.authorization !== `Bearer ${CAPTAIN}`) {
      socket.destroy();
      return;
    }
    serviceSockets.handleUpgrade(request, socket, head, (call) => {
      call.send(JSON.stringify({ schemaVersion: 1, type: "state", state: "listening" }));
      call.on("close", () => (hungUp += 1));
      call.on("message", (data, isBinary) => {
        if (!isBinary) return;
        heard.push(data as Buffer);
        call.send(data, { binary: true });
      });
    });
  });
  const serviceUrl = await listen(service);
  const upgrade = createVoiceCallUpgrade({
    authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl: control }),
    serviceUrl,
    captainToken: CAPTAIN,
    reauthorizeMs: 50,
  });
  const relayServer = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  relayServer.on("upgrade", (request, socket, head) => {
    if (!upgrade(request, socket, head)) socket.destroy();
  });
  const relay = await listen(relayServer);

  const wrappingKey = randomBytes(32);
  const connector = new PublicGatewayConnector({
    gatewayUrl: gateway,
    hostId: HOST_ID,
    hostToken: HOST_TOKEN,
    encryptionKey: wrappingKey,
    ...(options.carriesCalls === undefined ? {} : { carriesCalls: options.carriesCalls }),
    controlPlaneUrl: control,
    relayUrl: relay,
  });
  cleanups.push(() => connector.close());
  connector.start();
  await tunnelUp(gateway);

  async function post(path: string, body: unknown, bearer?: string): Promise<unknown> {
    const response = await fetch(`${control}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
  }

  /** A paired phone, and the gateway credential the Mac would have given it. */
  async function phone() {
    const offer = PairingOfferWireSchema.parse(await post("/v1/pairing/offer", {}, OWNER));
    const redeemed = PairingRedeemResponseSchema.parse(
      await post("/v1/pairing/redeem", { code: offer.localCode, device: { name: "Phone", platform: "ios" } }),
    );
    const completed = PairingCompleteResponseSchema.parse(
      await post("/v1/pairing/complete", {
        completionToken: redeemed.completionToken,
        acceptedGrants: redeemed.offeredGrants,
      }),
    );
    const key = randomBytes(32).toString("base64");
    const credential = {
      hostId: HOST_ID,
      key,
      ticket: sealGatewayValue(
        wrappingKey,
        JSON.stringify({
          key,
          subject: completed.deviceId,
          stage: "device",
          expiresAt: Date.now() + 600_000,
        }),
        `clankie-gateway-ticket-v1:${HOST_ID}`,
      ),
    };
    return { id: completed.deviceId, token: completed.deviceToken, credential };
  }

  return {
    app,
    gateway,
    logger,
    connector,
    heard,
    phone,
    call: (device: Awaited<ReturnType<typeof phone>>) => call(gateway, device),
    hungUp: () => hungUp,
  };
}

/**
 * The phone's half, as its native call drives the gateway socket: a fresh
 * opening through the gateway's challenge route, sent as the socket's first
 * message with no bearer, then one sealed binary record per message.
 */
async function call(
  gateway: string,
  device: { readonly token: string; readonly credential: Record<string, string> },
) {
  const opening = await createGatewayStreamOpening(
    {
      crypto: {
        randomBytes,
        seal: async (key, text, aad) => sealGatewayValue(Buffer.from(key, "base64"), text, aad),
        open: async (key, text, aad) => openGatewayValue(Buffer.from(key, "base64"), text, aad),
      },
      credential: () => device.credential as never,
    },
    `${gateway}/h/${HOST_ID}/v1/voice-call`,
    `Bearer ${device.token}`,
  );
  const key = Buffer.from(opening.key, "base64");
  const socket = new WebSocket(opening.url);
  const raw: Buffer[] = [];
  const text: string[] = [];
  let closed: number | undefined;
  let up = 0;
  socket.on("open", () => socket.send(opening.opening));
  socket.on("message", (data, isBinary) => {
    if (isBinary) raw.push(data as Buffer);
    else text.push(data.toString());
  });
  socket.on("close", (code) => (closed = code));
  socket.on("error", () => undefined);
  cleanups.push(() => socket.terminate());
  return {
    socket,
    opening,
    /** Each record the Mac sent, opened in order. */
    received: () =>
      raw.map((record, sequence) => {
        const plain = openGatewayBytes(key, record, `${opening.aadDown}#${sequence}`);
        return { kind: plain[0]!, payload: plain.subarray(1) };
      }),
    text,
    closed: () => closed,
    send(kind: number, payload: Buffer) {
      const sealed = sealGatewayBytes(
        key,
        Buffer.concat([Buffer.of(kind), payload]),
        `${opening.aadUp}#${up++}`,
      );
      socket.send(sealed, { binary: true });
      return sealed;
    },
  };
}

const startOf = (record: { kind: number; payload: Buffer } | undefined) => {
  expect(record?.kind).toBe(GATEWAY_STREAM_RECORD_START);
  return JSON.parse(record!.payload.toString()) as { status: number };
};

/** The upgrade's refusal status, as the phone's socket reports it. */
async function refusal(url: string, headers: Record<string, string> = {}): Promise<number> {
  const socket = new WebSocket(url, { headers });
  socket.on("error", () => undefined);
  const [, response] = (await once(socket, "unexpected-response")) as [unknown, IncomingMessage];
  response.resume();
  socket.terminate();
  return response.statusCode ?? 0;
}

describe("a phone's call through the gateway", () => {
  it("carries the call to the Mac's relay and back, sealed both ways", async () => {
    const fixture = await stack();
    const device = await fixture.phone();
    const phoneCall = await fixture.call(device);
    await until(() => phoneCall.received().length >= 2, "the call's start and first event");
    const [start, state] = phoneCall.received();
    expect(startOf(start)).toEqual({ status: 101 });
    expect(state!.kind).toBe(GATEWAY_STREAM_RECORD_TEXT);
    expect(JSON.parse(state!.payload.toString())).toMatchObject({ type: "state", state: "listening" });

    const audio = Buffer.alloc(960, 7);
    phoneCall.send(GATEWAY_STREAM_RECORD_BINARY, audio);
    phoneCall.send(GATEWAY_STREAM_RECORD_BINARY, Buffer.alloc(960, 9));
    await until(() => phoneCall.received().length >= 4, "the echoed audio");
    expect(fixture.heard.map((frame) => frame[0])).toEqual([7, 9]);
    expect(
      phoneCall
        .received()
        .slice(2)
        .map((record) => [record.kind, record.payload.length, record.payload[0]]),
    ).toEqual([
      [GATEWAY_STREAM_RECORD_BINARY, 960, 7],
      [GATEWAY_STREAM_RECORD_BINARY, 960, 9],
    ]);
    // Nothing the gateway sent the phone was plaintext.
    expect(phoneCall.text).toEqual([]);

    phoneCall.socket.close(1000);
    await until(() => fixture.hungUp() === 1, "the service's end of the call closing");
    // The gateway saw sizes and ids, never the bearer, the route or an event.
    const seen = fixture.logger.text();
    expect(seen).toContain("gateway stream closed");
    expect(seen).not.toContain(device.token);
    expect(seen).not.toContain("voice-call");
    expect(seen).not.toContain("listening");
  });

  it("ends the phone's call with the Mac's close when the device is revoked", async () => {
    const fixture = await stack();
    const device = await fixture.phone();
    const phoneCall = await fixture.call(device);
    await until(() => phoneCall.received().length >= 1, "the call's start");
    const revoked = await fixture.app.app.request(`/v1/devices/${device.id}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER}` },
    });
    expect(revoked.status).toBe(200);
    await until(() => phoneCall.closed() !== undefined, "the phone's socket closing");
    expect(phoneCall.closed()).toBe(1008);
    const events = phoneCall
      .received()
      .filter((record) => record.kind === GATEWAY_STREAM_RECORD_TEXT)
      .map((record) => JSON.parse(record.payload.toString()) as { type: string; reason?: string });
    expect(events.at(-1)).toEqual({ schemaVersion: 1, type: "ended", reason: "revoked" });
  });

  it("ends the call when the Mac goes away, and carries the next one once it is back", async () => {
    const fixture = await stack();
    const device = await fixture.phone();
    const first = await fixture.call(device);
    await until(() => first.received().length >= 2, "the first call");
    fixture.connector.close();
    await until(() => first.closed() !== undefined, "the phone's socket closing");
    expect(first.closed()).toBe(1001);

    fixture.connector.start();
    await tunnelUp(fixture.gateway);
    const next = await fixture.call(device);
    await until(() => next.received().length >= 2, "the next call");
    expect(startOf(next.received()[0])).toEqual({ status: 101 });
  });

  it("refuses with statuses the phone explains, before any socket is opened", async () => {
    const fixture = await stack({ carriesCalls: false });
    const ws = fixture.gateway.replace("http", "ws");
    // A Mac that doesn't carry calls yet: the phone says to update Clankie on the Mac.
    expect(await refusal(`${ws}/h/${HOST_ID}/v1/gateway/stream`)).toBe(404);
    // No Mac connected under that id.
    expect(await refusal(`${ws}/h/mac_absent_12345678/v1/gateway/stream`)).toBe(503);
    // A bearer outside the sealed opening is plaintext.
    expect(await refusal(`${ws}/h/${HOST_ID}/v1/gateway/stream`, { authorization: "Bearer plain" })).toBe(
      400,
    );
    expect(await refusal(`${ws}/h/${HOST_ID}/v1/gateway/stream?x=1`)).toBe(404);
  });
});

/** A Mac played by the test, holding its tunnel the way the gateway sees it. */
async function scriptedMac(origin: string) {
  const frames: PublicGatewayTunnelFrame[] = [];
  const socket = new WebSocket(
    `${origin.replace("http", "ws")}${PUBLIC_GATEWAY_HOST_CONNECT_PATH}?hostId=${HOST_ID}`,
    { headers: { authorization: `Bearer ${HOST_TOKEN}`, [PUBLIC_GATEWAY_STREAMS_HEADER]: "1" } },
  );
  cleanups.push(() => socket.terminate());
  socket.on("message", (data) =>
    frames.push(PublicGatewayTunnelFrameSchema.parse(JSON.parse(data.toString()))),
  );
  await once(socket, "open");
  return {
    socket,
    frames,
    send: (frame: PublicGatewayTunnelFrame) => socket.send(JSON.stringify(frame)),
    opened: () => frames.filter((frame) => frame.kind === "stream_open"),
  };
}

function phoneSocket(origin: string) {
  const socket = new WebSocket(`${origin.replace("http", "ws")}/h/${HOST_ID}/v1/gateway/stream`);
  let closed: number | undefined;
  socket.on("close", (code) => (closed = code));
  socket.on("error", () => undefined);
  cleanups.push(() => socket.terminate());
  return { socket, closed: () => closed };
}

describe("the gateway's half of a sealed stream", () => {
  it("survives a Mac's close code a WebSocket can't send, and still carries calls", async () => {
    const { origin } = await startGateway();
    const mac = await scriptedMac(origin);
    for (const [index, code] of [1004, 1015, 2999, 1005].entries()) {
      const phone = phoneSocket(origin);
      await once(phone.socket, "open");
      phone.socket.send('{"version":1}');
      await until(() => mac.opened().length === index + 1, "the opening");
      const { streamId } = mac.opened()[index] as Extract<PublicGatewayTunnelFrame, { kind: "stream_open" }>;
      mac.send({ schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION, kind: "stream_close", streamId, code });
      await until(() => phone.closed() !== undefined, "the phone's close");
      expect(phone.closed()).toBe(code === 1005 ? 1000 : 1011);
    }
    expect(mac.socket.readyState).toBe(WebSocket.OPEN);
    expect((await fetch(`${origin}/health`)).status).toBe(200);
  });

  it("passes records through unread, and ends a stream that breaks the contract", async () => {
    const { origin } = await startGateway();
    const mac = await scriptedMac(origin);
    const phone = phoneSocket(origin);
    await once(phone.socket, "open");
    phone.socket.send('{"version":1}');
    await until(() => mac.opened().length === 1, "the opening");
    const opened = mac.opened()[0] as Extract<PublicGatewayTunnelFrame, { kind: "stream_open" }>;
    expect(opened.envelope).toBe('{"version":1}');

    const down: Buffer[] = [];
    phone.socket.on("message", (data) => down.push(data as Buffer));
    mac.send({
      schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION,
      kind: "stream_data",
      streamId: opened.streamId,
      dataBase64: Buffer.from("sealed-down").toString("base64"),
    });
    phone.socket.send(Buffer.from("sealed-up"), { binary: true });
    await until(() => down.length === 1, "the downlink record");
    expect(down[0]!.toString()).toBe("sealed-down");
    await until(
      () => mac.frames.some((frame) => frame.kind === "stream_data"),
      "the uplink record at the Mac",
    );
    const uplink = mac.frames.find((frame) => frame.kind === "stream_data") as Extract<
      PublicGatewayTunnelFrame,
      { kind: "stream_data" }
    >;
    expect(Buffer.from(uplink.dataBase64, "base64").toString()).toBe("sealed-up");

    // After the opening only sealed binary records are a call; text ends it, and the Mac hears.
    phone.socket.send("plaintext");
    await until(() => phone.closed() !== undefined, "the close on plaintext");
    expect(phone.closed()).toBe(1008);
    await until(
      () => mac.frames.some((frame) => frame.kind === "stream_close"),
      "the Mac hearing the stream end",
    );

    // An opening must be text, and a phone has room for two calls.
    const binaryOpening = phoneSocket(origin);
    await once(binaryOpening.socket, "open");
    binaryOpening.socket.send(Buffer.from("not an opening"), { binary: true });
    await until(() => binaryOpening.closed() !== undefined, "the close on a binary opening");
    expect(binaryOpening.closed()).toBe(1008);
    expect(mac.opened()).toHaveLength(1);

    const calls = [phoneSocket(origin), phoneSocket(origin)];
    await Promise.all(calls.map((entry) => once(entry.socket, "open")));
    expect(await refusal(`${origin.replace("http", "ws")}/h/${HOST_ID}/v1/gateway/stream`)).toBe(429);
  });
});
