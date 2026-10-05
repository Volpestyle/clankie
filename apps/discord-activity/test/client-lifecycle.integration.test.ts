import { ActivityShareFrameSchema, RenderedSurfaceMessageSchema } from "@clankie/interactive-environment";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import { createActivityShareClient } from "../../../packages/rendered-surface-client/src/activity-share-client.ts";
import { createActivityFrameSink } from "../../../packages/rendered-surface-client/src/activity-frame-sink.ts";
import { RenderedSurfaceHub } from "../src/frame-hub.ts";
import { createFrameProducerServer } from "../src/producer.ts";
import { createDiscordActivityServer } from "../src/server.ts";
import { ActivityShareRegistry } from "../src/share-registry.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
  "base64",
);
const frame = (sequence: number) =>
  ActivityShareFrameSchema.parse({
    schemaVersion: 2,
    sequence,
    width: 1,
    height: 1,
    encoding: "png",
    data: PNG.toString("base64"),
    byteLength: PNG.length,
    sha256: createHash("sha256").update(PNG).digest("hex"),
    capturedAt: new Date().toISOString(),
  });

/** Execute the served viewer against real sockets; only rendering devices are controlled. */
function browser(html: string, port: number, hash: string) {
  const elements = new Map<
    string,
    {
      textContent: string;
      dataset: Record<string, string>;
      hidden: boolean;
      value: string;
      classList: { toggle(): void };
      setAttribute(): void;
      addEventListener(name: string, handler: () => unknown): void;
      listeners: Map<string, () => unknown>;
    }
  >();
  const get = (id: string) => {
    if (!elements.has(id)) {
      const listeners = new Map<string, () => unknown>();
      elements.set(id, {
        textContent: "",
        dataset: {},
        hidden: false,
        value: "0.2",
        classList: { toggle() {} },
        setAttribute() {},
        addEventListener: (name, handler) => {
          listeners.set(name, handler);
        },
        listeners,
      });
    }
    return elements.get(id)!;
  };
  const draws: unknown[] = [];
  const canvas = Object.assign(get("screen"), {
    width: 240,
    height: 160,
    getContext: () => ({
      imageSmoothingEnabled: false,
      clearRect() {},
      drawImage: (image: unknown) => draws.push(image),
    }),
  });
  const images: ControlledImage[] = [];
  class ControlledImage {
    src = "";
    private readonly listeners = new Map<string, () => void>();
    constructor() {
      images.push(this);
    }
    addEventListener(name: string, handler: () => void) {
      this.listeners.set(name, handler);
    }
    complete() {
      this.listeners.get("load")?.();
    }
  }
  const sounds: { stopped: boolean }[] = [];
  class AudioContext {
    currentTime = 0;
    destination = {};
    async resume() {}
    createGain() {
      return { gain: { value: 0 }, connect() {} };
    }
    createBuffer(channels: number, frames: number, rate: number) {
      return { duration: frames / rate, getChannelData: () => new Float32Array(frames), channels };
    }
    createBufferSource() {
      const record = { stopped: false };
      return {
        buffer: null,
        connect() {},
        addEventListener() {},
        start() {
          sounds.push(record);
        },
        stop() {
          record.stopped = true;
        },
      };
    }
  }
  const sockets: WebSocket[] = [];
  class BrowserSocket {
    private readonly ws: WebSocket;
    constructor(url: string) {
      this.ws = new WebSocket(url);
      sockets.push(this.ws);
    }
    addEventListener(name: string, handler: (event: unknown) => void) {
      if (name === "message") this.ws.on("message", (raw) => handler({ data: raw.toString() }));
      else if (name === "close") this.ws.on("close", (code) => handler({ code }));
      else this.ws.on(name, () => handler({}));
    }
    send(data: string) {
      this.ws.send(data);
    }
    close() {
      this.ws.close();
    }
  }
  const reconnects: (() => void)[] = [];
  const script = html.match(/<script type="module">([\s\S]+)<\/script>/u)?.[1];
  if (script === undefined) throw new Error("viewer has no script");
  runInNewContext(script, {
    document: {
      getElementById: (id: string) => (id === "screen" ? canvas : get(id)),
      documentElement: { style: { setProperty() {} } },
    },
    location: { protocol: "http:", host: `127.0.0.1:${port}`, hash },
    Image: ControlledImage,
    WebSocket: BrowserSocket,
    AudioContext,
    URLSearchParams,
    atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
    setInterval() {},
    setTimeout: (callback: () => void) => reconnects.push(callback),
  });
  return {
    images,
    draws,
    sounds,
    reconnects,
    sockets,
    get,
    close: () => {
      for (const socket of sockets) socket.terminate();
    },
  };
}

it("renders game and image shares, fencing delayed decode/audio and terminal reconnect in the served viewer", async () => {
  const shares = new ActivityShareRegistry();
  const hub = new RenderedSurfaceHub();
  const producer = createFrameProducerServer({ hub, shares, token: "producer-control" });
  const activity = createDiscordActivityServer({ hub, shares });
  const p = await producer.listen(0),
    v = await activity.listen(0);
  const client = createActivityShareClient({ url: `http://127.0.0.1:${p}`, token: "producer-control" });
  let view: ReturnType<typeof browser> | undefined;
  try {
    const a = await client.start({
      scope: { tenantId: "local", installationId: "test", guildId: "1", channelId: "2" },
      source: { kind: "game", id: "firered", title: "FireRed" },
    });
    const grant = await client.grant(a);
    const html = await (await fetch(`http://127.0.0.1:${v}/`)).text();
    view = browser(html, v, `#share=${a.shareId}&grant=${grant.grant}`);
    const sink = client.sink(a);
    await vi.waitFor(() => expect(sink.connected && shares.stats()[0]?.viewerCount === 1).toBe(true));
    sink.publishFrame(frame(100));
    await vi.waitFor(() => expect(view!.images).toHaveLength(1));
    const b = await client.switchSource(a, { kind: "image", id: "hash-bound-artifact", title: "Image" });
    const next = client.sink(b);
    await vi.waitFor(() => expect(next.connected).toBe(true));
    next.publishFrame(frame(1));
    await vi.waitFor(() => expect(view!.images).toHaveLength(2));
    view.images[0]!.complete();
    expect(view.draws).toHaveLength(0);
    view.images[1]!.complete();
    expect(view.draws).toHaveLength(1);
    await view.get("sound-toggle").listeners.get("click")?.();
    const pcm = Buffer.alloc(6400);
    const audio = {
      schemaVersion: 2 as const,
      sequence: 1,
      encoding: "pcm_s16le" as const,
      sampleRate: 8_000,
      channels: 2 as const,
      frames: 1600,
      data: pcm.toString("base64"),
      byteLength: pcm.length,
      capturedAt: new Date().toISOString(),
    };
    next.publishAudio(audio);
    next.publishAudio({ ...audio, sequence: 2 });
    await vi.waitFor(() => expect(view!.sounds).toHaveLength(1));
    next.publishFrame(frame(2));
    await vi.waitFor(() => expect(view!.images).toHaveLength(3));
    await client.stop(b);
    await vi.waitFor(() => expect(view!.get("empty-title").textContent).toBe("Session ended"));
    view.images[2]!.complete();
    expect(view.draws).toHaveLength(1);
    expect(view.sounds.every((sound) => sound.stopped)).toBe(true);
    await vi.waitFor(() => expect(view!.sockets[0]!.readyState).toBe(WebSocket.CLOSED));
    expect(view.reconnects).toEqual([]);
  } finally {
    view?.close();
    client.close();
    await activity.close();
    await producer.close();
  }
});

it("a scoped launch with missing admission never opens the public legacy stream", async () => {
  const activity = createDiscordActivityServer({ hub: new RenderedSurfaceHub() });
  const port = await activity.listen(0);
  let view: ReturnType<typeof browser> | undefined;
  try {
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    view = browser(html, port, "#share=e89ddcc6-7ddb-4a2f-83e2-649c6073f8cb");
    expect(view.sockets).toEqual([]);
    expect(view.get("empty-title").textContent).toBe("Session ended");
  } finally {
    view?.close();
    await activity.close();
  }
});

it("keeps legacy game media compatible and resets delayed decoding on producer replacement", async () => {
  const hub = new RenderedSurfaceHub();
  const producer = createFrameProducerServer({ hub, token: "control" });
  const activity = createDiscordActivityServer({ hub });
  const p = await producer.listen(0),
    v = await activity.listen(0);
  const old = new WebSocket(`ws://127.0.0.1:${p}/producer`, { headers: { authorization: "Bearer control" } });
  let view: ReturnType<typeof browser> | undefined;
  let sink: ReturnType<typeof createActivityFrameSink> | undefined;
  try {
    await new Promise<void>((done, reject) => {
      old.once("open", done);
      old.once("error", reject);
    });
    const html = await (await fetch(`http://127.0.0.1:${v}/`)).text();
    view = browser(html, v, "");
    await vi.waitFor(() => expect(hub.viewerCount).toBe(1));
    const legacy = { ...frame(100), schemaVersion: 1 as const, surface: "gba_emulator" as const, frame: 100 };
    old.send(JSON.stringify({ kind: "frame", frame: legacy }));
    await vi.waitFor(() => expect(view!.images).toHaveLength(1));
    sink = createActivityFrameSink({ url: `ws://127.0.0.1:${p}/producer`, token: "control" });
    await vi.waitFor(() => expect(sink!.connected).toBe(true));
    const next = { ...legacy, frame: 1, sequence: 1 };
    sink.publishFrame(next);
    await vi.waitFor(() => expect(view!.images).toHaveLength(2));
    expect(RenderedSurfaceMessageSchema.parse({ kind: "frame", frame: hub.snapshot() })).toEqual({
      kind: "frame",
      frame: next,
    });
    view.images[0]!.complete();
    expect(view.draws).toHaveLength(0);
    view.images[1]!.complete();
    expect(view.draws).toHaveLength(1);
    expect(view.sockets).toHaveLength(1);
  } finally {
    view?.close();
    old.terminate();
    sink?.close();
    await activity.close();
    await producer.close();
  }
});
