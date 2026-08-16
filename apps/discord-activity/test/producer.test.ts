import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RenderedSurfaceHub } from "../src/frame-hub.ts";
import { createFrameProducerServer, type FrameProducerServer } from "../src/producer.ts";

const TOKEN = "producer-secret";

function frameMessage(sequence: number): string {
  const png = Buffer.from(`png-${sequence}`);
  return JSON.stringify({
    kind: "frame",
    frame: {
      schemaVersion: 1,
      surface: "gba_emulator",
      sequence,
      frame: sequence,
      width: 240,
      height: 160,
      encoding: "png",
      data: png.toString("base64"),
      byteLength: png.byteLength,
      sha256: createHash("sha256").update(png).digest("hex"),
      capturedAt: "2026-07-25T18:00:00.000Z",
    },
  });
}

function dial(port: number, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const clientOptions = token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } };
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/producer`, clientOptions);
    socket.on("open", () => resolve(socket));
    socket.on("error", reject);
    socket.on("unexpected-response", () => reject(new Error("rejected")));
    socket.on("close", () => reject(new Error("closed")));
  });
}

let server: FrameProducerServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("frame producer server", () => {
  it("refuses to start without a token", () => {
    expect(() => createFrameProducerServer({ hub: new RenderedSurfaceHub(), token: "  " })).toThrow(
      /producer_token_required/,
    );
  });

  it("accepts frames from an authorized producer and forwards them to viewers", async () => {
    const hub = new RenderedSurfaceHub();
    server = createFrameProducerServer({ hub, token: TOKEN });
    const port = await server.listen(0);

    const sent: string[] = [];
    hub.addViewer({ send: (p: string) => sent.push(p), bufferedAmount: 0, close: () => undefined });

    const producer = await dial(port, TOKEN);
    producer.send(frameMessage(1));
    await new Promise((done) => setTimeout(done, 50));
    producer.close();
    await new Promise((done) => producer.once("close", done));
    await vi.waitFor(() => expect(hub.viewerCount).toBe(0));

    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[0] ?? "{}")).toMatchObject({ kind: "frame", frame: { sequence: 1 } });
    expect(JSON.parse(sent[1] ?? "{}")).toEqual({ kind: "stopped", reason: "session_ended" });
    expect(hub.viewerCount).toBe(0);
  });

  it("serves the latest frame on GET /snapshot to the producer bearer", async () => {
    const hub = new RenderedSurfaceHub();
    server = createFrameProducerServer({ hub, token: TOKEN });
    const port = await server.listen(0);
    const producer = await dial(port, TOKEN);
    producer.send(frameMessage(3));
    await vi.waitFor(() => expect(hub.snapshot()?.sequence).toBe(3));

    const denied = await fetch(`http://127.0.0.1:${String(port)}/snapshot`);
    expect(denied.status).toBe(401);

    const ok = await fetch(`http://127.0.0.1:${String(port)}/snapshot`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toMatchObject({ sequence: 3, encoding: "png", width: 240, height: 160 });
    producer.close();
  });

  it("rejects an unauthenticated or wrong-token producer", async () => {
    server = createFrameProducerServer({ hub: new RenderedSurfaceHub(), token: TOKEN });
    const port = await server.listen(0);

    await expect(dial(port)).rejects.toThrow();
    await expect(dial(port, "wrong-token")).rejects.toThrow();
    // A token that merely shares a prefix must not pass either.
    await expect(dial(port, "producer-secre")).rejects.toThrow();
  });

  it("drops a malformed frame instead of forwarding it to viewers", async () => {
    const hub = new RenderedSurfaceHub();
    server = createFrameProducerServer({ hub, token: TOKEN });
    const port = await server.listen(0);

    const sent: string[] = [];
    hub.addViewer({ send: (p: string) => sent.push(p), bufferedAmount: 0, close: () => undefined });

    const producer = await dial(port, TOKEN);
    producer.send("not json at all");
    producer.send(JSON.stringify({ kind: "frame", frame: { schemaVersion: 1 } }));
    // byteLength that disagrees with the payload must not reach a viewer.
    producer.send(frameMessage(2).replace('"byteLength":5', '"byteLength":999'));
    await new Promise((done) => setTimeout(done, 50));
    producer.close();
    await new Promise((done) => producer.once("close", done));
    await vi.waitFor(() => expect(hub.viewerCount).toBe(0));

    expect(sent.map((payload) => JSON.parse(payload).kind)).toEqual(["stopped"]);
  });

  it("binds loopback only so the producer is unreachable through the Discord proxy", async () => {
    server = createFrameProducerServer({ hub: new RenderedSurfaceHub(), token: TOKEN });
    await server.listen(0);
    const address = server.server.address();
    expect(typeof address === "object" && address !== null ? address.address : "").toBe("127.0.0.1");
  });
});
