import { createHash } from "node:crypto";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { RenderedSurfaceHub } from "../src/frame-hub.ts";
import { createFrameProducerServer, type FrameProducerServer } from "../src/producer.ts";

const TOKEN = "lifecycle-producer-secret";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
  "base64",
);

function frameMessage(sequence: number): string {
  return JSON.stringify({
    kind: "frame",
    frame: {
      schemaVersion: 1,
      surface: "gba_emulator",
      sequence,
      frame: sequence,
      width: 1,
      height: 1,
      encoding: "png",
      data: PNG.toString("base64"),
      byteLength: PNG.length,
      sha256: createHash("sha256").update(PNG).digest("hex"),
      capturedAt: new Date().toISOString(),
    },
  });
}

const sockets: WebSocket[] = [];
let server: FrameProducerServer | undefined;

async function dial(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/producer`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  sockets.push(socket);
  await once(socket, "open");
  return socket;
}

async function snapshot(port: number): Promise<Response> {
  return await fetch(`http://127.0.0.1:${String(port)}/snapshot`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server?.close();
  server = undefined;
});

describe("legacy producer lifecycle through the private listener", () => {
  it("ends the stopped producer before a queued late frame can restore its snapshot", async () => {
    const hub = new RenderedSurfaceHub();
    server = createFrameProducerServer({ hub, token: TOKEN });
    const port = await server.listen(0);
    const producer = await dial(port);
    producer.send(frameMessage(1));
    await vi.waitFor(async () => {
      await expect((await snapshot(port)).json()).resolves.toMatchObject({ sequence: 1 });
    });

    const closed = once(producer, "close");
    // Both writes enter the same live socket before its stop acknowledgement.
    producer.send(JSON.stringify({ kind: "stopped", reason: "operator_stop" }));
    producer.send(frameMessage(2));
    await closed;
    expect((await snapshot(port)).status).toBe(404);

    // A fresh play run may still establish a new legacy producer.
    const next = await dial(port);
    next.send(frameMessage(3));
    await vi.waitFor(async () => {
      await expect((await snapshot(port)).json()).resolves.toMatchObject({ sequence: 3 });
    });
  });

  it("ignores a replaced producer's late close after the replacement publishes", async () => {
    const hub = new RenderedSurfaceHub();
    server = createFrameProducerServer({ hub, token: TOKEN });
    const port = await server.listen(0);
    const upgraded = once(server.server, "upgrade");
    const old = await dial(port);
    const [, oldServerSocket] = await upgraded;
    old.send(frameMessage(100));
    await vi.waitFor(async () => {
      await expect((await snapshot(port)).json()).resolves.toMatchObject({ sequence: 100 });
    });
    // Hold the old socket's close handshake until the new producer has already
    // published its reset sequence. The eventual close must lose authority.
    old.pause();
    const next = await dial(port);
    next.send(frameMessage(1));
    await vi.waitFor(async () => {
      await expect((await snapshot(port)).json()).resolves.toMatchObject({ sequence: 1 });
    });
    const oldClosed = once(old, "close");
    const oldServerClosed = once(oldServerSocket, "close");
    old.terminate();
    await Promise.all([oldClosed, oldServerClosed]);
    next.send(frameMessage(2));
    await vi.waitFor(async () => {
      await expect((await snapshot(port)).json()).resolves.toMatchObject({ sequence: 2 });
    });
    expect(next.readyState).toBe(WebSocket.OPEN);
  });
});
