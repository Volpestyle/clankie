import { createServer, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
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
  PUBLIC_GATEWAY_SCHEMA_VERSION,
  PUBLIC_GATEWAY_STREAMS_HEADER,
  PublicGatewayTunnelFrameSchema,
  type PublicGatewayTunnelFrame,
} from "@clankie/protocol/public-gateway";
import {
  createGatewayStreamOpening,
  type GatewayStreamOpening,
} from "../../../packages/api-client/src/gateway-encryption.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { createVoiceCallUpgrade } from "../../relay/src/voice-call.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import {
  openGatewayBytes,
  openGatewayValue,
  sealGatewayBytes,
  sealGatewayValue,
} from "../src/gateway-encryption.ts";
import { PublicGatewayConnector } from "../src/public-gateway-connector.ts";

// A device's call carried as a sealed stream through the gateway (VUH-2761):
// the real connector, encryption host, service pairing and relay call route,
// with the gateway played by this test and the service's call end scripted.
// What the gateway relays is all it sees; the assertions read it as the gateway.

const hostId = "mac_stream_12345678";
const hostToken = "gateway-host-token-that-is-longer-than-thirty-two-characters";
const OWNER = "stream-owner-token";
const CAPTAIN = "stream-captain-token";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function until(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The Mac's socket as the gateway holds it: every frame it receives, and a way to send. */
interface GatewaySide {
  readonly request: IncomingMessage;
  readonly frames: PublicGatewayTunnelFrame[];
  readonly raw: string[];
  readonly socket: WebSocket;
  send(frame: PublicGatewayTunnelFrame): void;
}

async function stack(options: { refreshAt?: () => number; carriesCalls?: boolean } = {}) {
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

  // The service's call end: says it is listening, then echoes each audio frame.
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

  // The gateway, as the Mac sees it.
  const connections: GatewaySide[] = [];
  const gatewaySockets = new WebSocketServer({ noServer: true });
  const gatewayServer = createServer();
  gatewayServer.on("upgrade", (request, socket, head) => {
    gatewaySockets.handleUpgrade(request, socket, head, (webSocket) => {
      const side: GatewaySide = {
        request,
        frames: [],
        raw: [],
        socket: webSocket,
        send: (frame) => webSocket.send(JSON.stringify(frame)),
      };
      webSocket.on("message", (data) => {
        side.raw.push(data.toString());
        side.frames.push(PublicGatewayTunnelFrameSchema.parse(JSON.parse(data.toString())));
      });
      connections.push(side);
    });
  });
  const gateway = await listen(gatewayServer);
  const wrappingKey = randomBytes(32);
  const connector = new PublicGatewayConnector({
    gatewayUrl: gateway,
    hostId,
    ...(options.refreshAt === undefined
      ? { hostToken }
      : {
          installationId: "i".repeat(22),
          resolveHostToken: async () => ({
            token: hostToken,
            expiresAt: Date.now() + 60 * 60_000,
            refreshAt: options.refreshAt!(),
          }),
        }),
    encryptionKey: wrappingKey,
    ...(options.carriesCalls === undefined ? {} : { carriesCalls: options.carriesCalls }),
    controlPlaneUrl: control,
    relayUrl: relay,
  });
  cleanups.push(() => connector.close());
  connector.start();
  await until(() => connections.length === 1, "the Mac's connection");

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
  async function phone(grants: { chat?: boolean } = {}) {
    const offer = PairingOfferWireSchema.parse(await post("/v1/pairing/offer", {}, OWNER));
    const redeemed = PairingRedeemResponseSchema.parse(
      await post("/v1/pairing/redeem", { code: offer.localCode, device: { name: "Phone", platform: "ios" } }),
    );
    const completed = PairingCompleteResponseSchema.parse(
      await post("/v1/pairing/complete", {
        completionToken: redeemed.completionToken,
        acceptedGrants: { ...redeemed.offeredGrants, ...grants },
      }),
    );
    const key = randomBytes(32).toString("base64");
    const credential = {
      hostId,
      key,
      ticket: sealGatewayValue(
        wrappingKey,
        JSON.stringify({
          key,
          subject: completed.deviceId,
          stage: "device",
          expiresAt: Date.now() + 600_000,
        }),
        `clankie-gateway-ticket-v1:${hostId}`,
      ),
    };
    return { id: completed.deviceId, token: completed.deviceToken, credential };
  }

  /** The device's half: its opening through the gateway's request tunnel, then sealed records. */
  async function open(device: Awaited<ReturnType<typeof phone>>, side = connections.at(-1)!) {
    const fetchImpl: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname.slice(`/h/${hostId}`.length);
      const requestId = randomBytes(16).toString("hex");
      side.send({
        schemaVersion: 1,
        kind: "request",
        requestId,
        target: "control",
        method: "GET",
        path,
        headers: [],
      });
      await until(
        () => side.frames.some((frame) => frame.kind === "response_end" && frame.requestId === requestId),
        "the challenge",
      );
      const body = Buffer.concat(
        side.frames.flatMap((frame) =>
          frame.kind === "response_chunk" && frame.requestId === requestId
            ? [Buffer.from(frame.bodyBase64, "base64")]
            : [],
        ),
      );
      return new Response(body, { headers: { "content-type": "application/json" } });
    };
    const opening = await createGatewayStreamOpening(
      {
        crypto: {
          randomBytes,
          seal: async (key, text, aad) => sealGatewayValue(Buffer.from(key, "base64"), text, aad),
          open: async (key, text, aad) => openGatewayValue(Buffer.from(key, "base64"), text, aad),
        },
        credential: () => device.credential,
        fetchImpl,
      },
      `http://127.0.0.1/h/${hostId}/v1/voice-call`,
      `Bearer ${device.token}`,
    );
    return stream(side, opening);
  }
  return { app, connections, heard, phone, open, owner: OWNER, hungUp: () => hungUp };
}

/** One device stream, read and written as the device would through the gateway. */
function stream(side: GatewaySide, opening: GatewayStreamOpening) {
  const streamId = randomBytes(16).toString("hex");
  const key = Buffer.from(opening.key, "base64");
  let up = 0;
  side.send({ schemaVersion: 1, kind: "stream_open", streamId, envelope: opening.opening });
  const records = () =>
    side.frames.flatMap((frame) =>
      frame.kind === "stream_data" && frame.streamId === streamId
        ? [Buffer.from(frame.dataBase64, "base64")]
        : [],
    );
  return {
    streamId,
    opening,
    /** Each record the Mac sent, opened in order. */
    received(): { kind: number; payload: Buffer }[] {
      return records().map((record, sequence) => {
        const plain = openGatewayBytes(key, record, `${opening.aadDown}#${sequence}`);
        return { kind: plain[0]!, payload: plain.subarray(1) };
      });
    },
    closed: () =>
      side.frames.find(
        (frame): frame is Extract<PublicGatewayTunnelFrame, { kind: "stream_close" }> =>
          frame.kind === "stream_close" && frame.streamId === streamId,
      ),
    sendRecord(kind: number, payload: Buffer, sequence = up++) {
      const sealed = sealGatewayBytes(
        key,
        Buffer.concat([Buffer.of(kind), payload]),
        `${opening.aadUp}#${sequence}`,
      );
      side.send({ schemaVersion: 1, kind: "stream_data", streamId, dataBase64: sealed.toString("base64") });
      return sealed;
    },
    sendRaw(dataBase64: string) {
      side.send({ schemaVersion: 1, kind: "stream_data", streamId, dataBase64 });
    },
    hangUp(code = 1000) {
      side.send({ schemaVersion: PUBLIC_GATEWAY_SCHEMA_VERSION, kind: "stream_close", streamId, code });
    },
  };
}

const startOf = (record: { kind: number; payload: Buffer } | undefined) => {
  expect(record?.kind).toBe(GATEWAY_STREAM_RECORD_START);
  return JSON.parse(record!.payload.toString()) as { status: number };
};

it("carries a phone's call to the relay's own call route, sealed both ways", async () => {
  const fixture = await stack();
  const side = fixture.connections[0]!;
  expect(side.request.headers[PUBLIC_GATEWAY_STREAMS_HEADER]).toBe("1");
  const device = await fixture.phone();
  const call = await fixture.open(device);
  await until(() => call.received().length >= 2, "the call's start and first event");
  const [start, state] = call.received();
  expect(startOf(start)).toEqual({ status: 101 });
  expect(state!.kind).toBe(GATEWAY_STREAM_RECORD_TEXT);
  expect(JSON.parse(state!.payload.toString())).toMatchObject({ type: "state", state: "listening" });

  const audio = Buffer.alloc(960, 7);
  call.sendRecord(GATEWAY_STREAM_RECORD_BINARY, audio);
  call.sendRecord(GATEWAY_STREAM_RECORD_BINARY, Buffer.alloc(960, 9));
  await until(() => call.received().length >= 4, "the echoed audio");
  expect(fixture.heard.map((frame) => frame[0])).toEqual([7, 9]);
  const echoed = call.received().slice(2);
  expect(echoed.map((record) => [record.kind, record.payload.length, record.payload[0]])).toEqual([
    [GATEWAY_STREAM_RECORD_BINARY, 960, 7],
    [GATEWAY_STREAM_RECORD_BINARY, 960, 9],
  ]);

  // The gateway carried no bearer, no route and no audio it could read.
  const seen = side.raw.join("\n");
  expect(seen).not.toContain(device.token);
  expect(seen).not.toContain("voice-call");
  expect(seen).not.toContain(audio.toString("base64").slice(0, 64));
  expect(seen).not.toContain("listening");

  call.hangUp();
  await until(() => fixture.hungUp() === 1, "the service's end of the call closing");
  expect(call.closed()).toBeUndefined();
});

it("ends the call when the device is revoked, as a direct call would", async () => {
  const fixture = await stack();
  const device = await fixture.phone();
  const call = await fixture.open(device);
  await until(() => call.received().length >= 1, "the call's start");
  const revoked = await fixture.app.app.request(`/v1/devices/${device.id}/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${fixture.owner}` },
  });
  expect(revoked.status).toBe(200);
  await until(() => call.closed() !== undefined, "the stream's close");
  const events = call
    .received()
    .filter((record) => record.kind === GATEWAY_STREAM_RECORD_TEXT)
    .map((record) => JSON.parse(record.payload.toString()) as { type: string; reason?: string });
  expect(events.at(-1)).toEqual({ schemaVersion: 1, type: "ended", reason: "revoked" });
  expect(call.closed()!.code).toBe(1008);
});

it("answers a device without the chat grant with the relay's refusal, sealed", async () => {
  const fixture = await stack();
  const device = await fixture.phone({ chat: false });
  const call = await fixture.open(device);
  await until(() => call.closed() !== undefined, "the refusal");
  expect(call.received()).toHaveLength(1);
  expect(startOf(call.received()[0])).toEqual({ status: 403 });
  expect(fixture.heard).toHaveLength(0);
});

it("refuses a replayed opening, and ends a stream on a replayed, reordered or forged record", async () => {
  const fixture = await stack();
  const side = fixture.connections[0]!;
  const device = await fixture.phone();
  const call = await fixture.open(device);
  await until(() => call.received().length >= 2, "the call");

  // The same opening again: its challenge is spent, so nothing opens and nothing is sealed.
  const replay = stream(side, call.opening);
  await until(() => replay.closed() !== undefined, "the replay's refusal");
  expect(replay.closed()!.code).toBe(1008);
  expect(replay.received()).toHaveLength(0);

  const first = call.sendRecord(GATEWAY_STREAM_RECORD_BINARY, Buffer.alloc(960, 1));
  await until(() => fixture.heard.length === 1, "the first frame");
  call.sendRaw(first.toString("base64"));
  await until(() => call.closed() !== undefined, "the close on a replayed record");
  expect(call.closed()!.code).toBe(1008);
  expect(fixture.heard).toHaveLength(1);

  const skipped = await fixture.open(device);
  await until(() => skipped.received().length >= 1, "a second call");
  skipped.sendRecord(GATEWAY_STREAM_RECORD_BINARY, Buffer.alloc(960, 2), 1);
  await until(() => skipped.closed() !== undefined, "the close on a reordered record");

  const forged = await fixture.open(device);
  await until(() => forged.received().length >= 1, "a third call");
  const tampered = forged.sendRecord(GATEWAY_STREAM_RECORD_BINARY, Buffer.alloc(0), 99);
  tampered[20]! ^= 1;
  forged.sendRaw(tampered.toString("base64"));
  await until(() => forged.closed() !== undefined, "the close on a forged record");
  expect(fixture.heard).toHaveLength(1);
});

it("holds a credential refresh until the call ends, then reconnects", async () => {
  let refreshAt = Date.now() + 150;
  const fixture = await stack({ refreshAt: () => refreshAt });
  const device = await fixture.phone();
  const call = await fixture.open(device);
  await until(() => call.received().length >= 2, "the call");
  refreshAt = Date.now() + 60 * 60_000;
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(fixture.connections).toHaveLength(1);
  call.sendRecord(GATEWAY_STREAM_RECORD_BINARY, Buffer.alloc(960, 3));
  await until(() => fixture.heard.length === 1, "audio after the refresh came due");
  call.hangUp();
  await until(() => fixture.connections.length === 2, "the deferred reconnect");
});

it("refuses one phone's ticket carrying another phone's bearer, before the relay sees it", async () => {
  const fixture = await stack();
  const [first, second] = [await fixture.phone(), await fixture.phone()];
  const call = await fixture.open({ ...first, token: second.token });
  await until(() => call.closed() !== undefined, "the refusal");
  expect(call.closed()!.code).toBe(1008);
  expect(call.received()).toHaveLength(0);
  expect(fixture.hungUp()).toBe(0);
});

it("survives a hang-up whose close code a WebSocket can't send, and carries the next call", async () => {
  const fixture = await stack();
  const side = fixture.connections[0]!;
  const device = await fixture.phone();
  for (const [index, code] of [1004, 1015, 2999].entries()) {
    const call = await fixture.open(device);
    await until(() => call.received().length >= 2, "the call");
    call.hangUp(code);
    await until(() => fixture.hungUp() === index + 1, "the relay's end of the call");
  }
  expect(fixture.connections).toHaveLength(1);
  expect(side.socket.readyState).toBe(WebSocket.OPEN);
  const next = await fixture.open(device);
  await until(() => next.received().length >= 2, "the next call");
  expect(startOf(next.received()[0])).toEqual({ status: 101 });
});

it("neither offers nor opens calls on a body that doesn't carry them", async () => {
  const fixture = await stack({ carriesCalls: false });
  const side = fixture.connections[0]!;
  expect(side.request.headers[PUBLIC_GATEWAY_STREAMS_HEADER]).toBeUndefined();
  const call = await fixture.open(await fixture.phone());
  await until(() => call.closed() !== undefined, "the refusal");
  expect(call.received()).toHaveLength(0);
  expect(fixture.hungUp()).toBe(0);
});
