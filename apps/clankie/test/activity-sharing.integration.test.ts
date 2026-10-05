import { serve } from "@hono/node-server";
import { mintOperatorToken } from "@clankie/credential-broker";
import { ActivityShareFrameSchema, type ActivityShareSession } from "@clankie/interactive-environment";
import { createActivityShareClient, createActivityShareSink } from "@clankie/rendered-surface-client";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { RenderedSurfaceHub } from "../../discord-activity/src/frame-hub.ts";
import { createFrameProducerServer } from "../../discord-activity/src/producer.ts";
import { createDiscordActivityServer } from "../../discord-activity/src/server.ts";
import { ActivityShareRegistry } from "../../discord-activity/src/share-registry.ts";
import { runShareCommand } from "../../tui/src/command/share.ts";
import { ActivitySharing } from "../src/activity-sharing.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { DeliveredFileStore } from "../src/delivered-files.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
  "base64",
);
const scope = (tenantId: string, guildId = tenantId) => ({
  tenantId,
  installationId: `install-${tenantId}`,
  guildId,
  channelId: `room-${guildId}`,
});
const source = { kind: "game" as const, id: "pokemon-firered", title: "FireRed" };
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
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function plane(options: ConstructorParameters<typeof ActivityShareRegistry>[0] = {}) {
  const shares = new ActivityShareRegistry(options);
  const hub = new RenderedSurfaceHub();
  const producer = createFrameProducerServer({ shares, hub, token: "control-secret" });
  const viewer = createDiscordActivityServer({ shares, hub, admissionTimeoutMs: 50, maxPendingViewers: 2 });
  const producerPort = await producer.listen(0);
  const viewerPort = await viewer.listen(0);
  cleanup.push(async () => {
    await viewer.close();
    await producer.close();
  });
  const client = createActivityShareClient({
    url: `http://127.0.0.1:${producerPort}`,
    token: "control-secret",
  });
  cleanup.push(() => client.close());
  return {
    shares,
    client,
    producerUrl: `http://127.0.0.1:${producerPort}`,
    viewerUrl: `ws://127.0.0.1:${viewerPort}`,
    httpViewerUrl: `http://127.0.0.1:${viewerPort}`,
  };
}

async function viewer(url: string, session: ActivityShareSession, grant?: string) {
  const socket = new WebSocket(`${url}/.proxy/shares/${session.shareId}/frames`);
  cleanup.push(() => socket.terminate());
  const messages: Record<string, any>[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await new Promise<void>((done, reject) => {
    socket.once("open", done);
    socket.once("error", reject);
  });
  const closed = new Promise<number>((done) => socket.once("close", (code) => done(code)));
  if (grant !== undefined) socket.send(JSON.stringify({ kind: "admit", grant }));
  return { socket, messages, closed };
}

it("projects an exact delivered artifact through owner CLI, real Clankie HTTP and Activity sockets", async () => {
  const p = await plane();
  const root = await mkdtemp(join(tmpdir(), "clankie-share-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "view.png"), PNG);
  const files = new DeliveredFileStore(join(root, "artifacts"));
  const artifact = await files.publish({ conversationId: "owner", sourceRoot: root, path: "view.png" });
  let authorized = true;
  let revokeOnRead = false;
  const sharing = new ActivitySharing({
    files: {
      read: async (conversation, id) => {
        const found = await files.read(conversation, id);
        if (revokeOnRead) authorized = false;
        return found;
      },
    },
    token: async () => "control-secret",
    url: p.producerUrl,
  });
  const operatorToken = mintOperatorToken();
  const service = await createClankieApp({
    captain: createStubCaptain(),
    eventLogPath: join(root, "events.jsonl"),
    activitySharing: sharing,
    authenticateOperator: async (req) =>
      authorized && req.headers.get("authorization") === `Bearer ${operatorToken}`
        ? { operatorId: "owner" }
        : undefined,
  });
  const http = serve({ fetch: (req) => service.app.fetch(req), hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((done) => http.once("listening", done));
  cleanup.push(async () => {
    service.close();
    await new Promise<void>((done) => http.close(() => done()));
  });
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("missing test service address");
  const host = `http://127.0.0.1:${address.port}`;
  const command = (input: unknown) =>
    runShareCommand(["request", JSON.stringify(input)], {
      host,
      env: { CLANKIE_OPERATOR_TOKEN: operatorToken },
    });
  expect(
    (await fetch(`${host}/v1/activity/shares`, { method: "POST", body: JSON.stringify({ action: "list" }) }))
      .status,
  ).toBe(401);
  expect(
    (
      await command({
        action: "image",
        conversationId: "foreign",
        artifactId: artifact.artifactId,
        guildId: "1",
        channelId: "2",
      })
    ).ok,
  ).toBe(false);
  expect(await p.client.status()).toEqual([]);
  const created = await command({
    action: "image",
    conversationId: "owner",
    artifactId: artifact.artifactId,
    guildId: "1",
    channelId: "2",
  });
  expect(created.ok).toBe(true);
  const session = (created.body as { session: ActivityShareSession }).session;
  expect(session.source.kind).toBe("image");
  const admitted = await command({
    action: "grant",
    shareId: session.shareId,
    generation: session.generation,
  });
  const v = await viewer(p.viewerUrl, session, (admitted.body as { grant: string }).grant);
  await vi.waitFor(() => expect(v.messages.map((m) => m.kind)).toEqual(["session", "frame"]));
  expect(v.messages[1]!.frame.sha256).toBe(artifact.sha256);
  expect(v.messages[1]!.frame).not.toHaveProperty("surface");
  const switched = await command({
    action: "switch",
    shareId: session.shareId,
    generation: 1,
    conversationId: "owner",
    artifactId: artifact.artifactId,
  });
  expect(switched.ok).toBe(true);
  await vi.waitFor(() =>
    expect(v.messages.at(-1)).toMatchObject({ kind: "frame", generation: 2, frame: { sequence: 1 } }),
  );
  expect((await command({ action: "stop", shareId: session.shareId, generation: 1 })).ok).toBe(false);
  expect(await command({ action: "stop", shareId: session.shareId, generation: 2 })).toEqual({
    ok: true,
    body: { stopped: true },
  });
  await v.closed;
  expect(v.messages.at(-1)).toMatchObject({ kind: "stopped", generation: 2 });
  revokeOnRead = true;
  expect(
    await command({
      action: "image",
      conversationId: "owner",
      artifactId: artifact.artifactId,
      guildId: "1",
      channelId: "2",
    }),
  ).toEqual({ ok: false, body: { error: "operator_authentication_required" } });
  expect(await p.client.status()).toEqual([]);
});

it("isolates concurrent shares and denies control, foreign, expired and missing viewer grants", async () => {
  let now = Date.now();
  const p = await plane({ now: () => now });
  const a = await p.client.start({ scope: scope("A"), source });
  const b = await p.client.start({ scope: scope("B"), source: { kind: "demo", id: "demo", title: "Demo" } });
  const ga = await p.client.grant(a, 1_000);
  const gb = await p.client.grant(b);
  const va = await viewer(p.viewerUrl, a, ga.grant);
  const vb = await viewer(p.viewerUrl, b, gb.grant);
  for (const [session, grant] of [
    [b, ga.grant],
    [a, "control-secret"],
    [a, "wrong"],
  ] as const) {
    const denied = await viewer(p.viewerUrl, session, grant);
    expect(await denied.closed).toBe(4403);
    expect(denied.messages).toEqual([]);
  }
  const pending = await viewer(p.viewerUrl, a);
  expect(await pending.closed).toBe(4408);
  const sa = p.client.sink(a),
    sb = p.client.sink(b);
  await vi.waitFor(() => expect(sa.connected && sb.connected).toBe(true));
  sa.publishFrame(frame(1));
  sb.publishFrame(frame(2));
  await vi.waitFor(() =>
    expect(va.messages.at(-1)).toMatchObject({ kind: "frame", shareId: a.shareId, frame: { sequence: 1 } }),
  );
  await vi.waitFor(() =>
    expect(vb.messages.at(-1)).toMatchObject({ kind: "frame", shareId: b.shareId, frame: { sequence: 2 } }),
  );
  expect(va.messages.every((m) => m.kind === "session" || m.shareId === a.shareId)).toBe(true);
  expect(vb.messages.every((m) => m.kind === "session" || m.shareId === b.shareId)).toBe(true);
  now += 1_001;
  const expired = await viewer(p.viewerUrl, a, ga.grant);
  expect(await expired.closed).toBe(4403);
  expect((await fetch(`${p.httpViewerUrl}/shares`, { method: "POST" })).status).toBe(404);
  expect((await fetch(`${p.producerUrl}/shares`)).status).toBe(401);
});

it("fences generation switches, old credentials, stale packets and terminal producer reconnect", async () => {
  const p = await plane();
  const a = await p.client.start({ scope: scope("A"), source });
  const ga = await p.client.grant(a);
  const v = await viewer(p.viewerUrl, a, ga.grant);
  const old = p.client.sink(a);
  await vi.waitFor(() => expect(old.connected).toBe(true));
  old.publishFrame(frame(100));
  await vi.waitFor(() => expect(v.messages.at(-1)).toMatchObject({ kind: "frame", generation: 1 }));
  const b = await p.client.switchSource(a, {
    kind: "animation",
    id: "generated-animation",
    title: "Animation",
  });
  const next = p.client.sink(b);
  await vi.waitFor(() => expect(next.connected).toBe(true));
  old.publishFrame(frame(101));
  next.publishFrame(frame(1));
  await vi.waitFor(() =>
    expect(v.messages.at(-1)).toMatchObject({ kind: "frame", generation: 2, frame: { sequence: 1 } }),
  );
  expect(v.messages.filter((m) => m.kind === "frame").map((m) => m.frame.sequence)).toEqual([100, 1]);
  const late = await viewer(p.viewerUrl, b, ga.grant);
  expect(await late.closed).toBe(4403);
  next.close();
  await v.closed;
  expect(v.messages.at(-1)).toMatchObject({ kind: "stopped", reason: "session_ended" });
  expect(await p.client.status()).toEqual([]);
  await expect(p.client.grant(b)).rejects.toMatchObject({ outcome: "refused" });
  const terminal = await viewer(p.viewerUrl, b, ga.grant);
  expect(await terminal.closed).toBe(4403);
});

it("requires a generation producer credential and refuses a second producer without disturbing the first", async () => {
  const p = await plane();
  const response = await fetch(`${p.producerUrl}/shares`, {
    method: "POST",
    headers: { authorization: "Bearer control-secret", "content-type": "application/json" },
    body: JSON.stringify({ scope: scope("A"), source }),
  });
  const { session, producerToken } = (await response.json()) as {
    session: ActivityShareSession;
    producerToken: string;
  };
  const grant = await p.client.grant(session);
  const v = await viewer(p.viewerUrl, session, grant.grant);
  const dial = async (token: string) => {
    const socket = new WebSocket(
      `${p.producerUrl.replace(/^http/u, "ws")}/shares/${session.shareId}/producer`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    cleanup.push(() => socket.terminate());
    const closed = new Promise<number>((done) => socket.once("close", done));
    await new Promise<void>((done, reject) => {
      socket.once("open", done);
      socket.once("error", reject);
    });
    return { socket, closed };
  };
  expect(await (await dial("control-secret")).closed).toBe(4403);
  const first = await dial(producerToken);
  expect(await (await dial(producerToken)).closed).toBe(4409);
  first.socket.send(
    JSON.stringify({ kind: "frame", shareId: session.shareId, generation: 1, frame: frame(1) }),
  );
  await vi.waitFor(() => expect(v.messages.at(-1)).toMatchObject({ kind: "frame" }));
  first.socket.close();
  await first.closed;
  await v.closed;
  expect(await (await dial(producerToken)).closed).toBe(4403);
});

it("invalidates an old installation and preserves one tenant per guild after stop", async () => {
  const p = await plane();
  const old = await p.client.start({ scope: scope("A", "guild"), source });
  const grant = await p.client.grant(old);
  const v = await viewer(p.viewerUrl, old, grant.grant);
  const replacement = await p.client.start({
    scope: { ...old.scope, installationId: "new-installation" },
    source,
  });
  await v.closed;
  expect(v.messages.at(-1)).toMatchObject({ kind: "stopped" });
  await p.client.stop(replacement);
  await expect(p.client.start({ scope: scope("B", "guild"), source })).rejects.toMatchObject({
    outcome: "refused",
  });
  expect(await p.client.status()).toEqual([]);
});

it("validates bounded media at real ingress, keeps sound live-only, and expires shares", async () => {
  let now = Date.now();
  const p = await plane({ now: () => now });
  const a = await p.client.start({ scope: scope("A"), source, ttlMs: 10_000 });
  const grant = await p.client.grant(a);
  const v = await viewer(p.viewerUrl, a, grant.grant);
  const sink = p.client.sink(a);
  await vi.waitFor(() => expect(sink.connected).toBe(true));
  const pcm = Buffer.alloc(320);
  const audio = {
    schemaVersion: 2 as const,
    sequence: 1,
    encoding: "pcm_s16le" as const,
    sampleRate: 8_000,
    channels: 2 as const,
    frames: 80,
    data: pcm.toString("base64"),
    byteLength: pcm.length,
    capturedAt: new Date().toISOString(),
  };
  sink.publishFrame({ ...frame(1), sha256: "0".repeat(64) });
  sink.publishFrame({ ...frame(2), width: 2 });
  sink.publishFrame({ ...frame(3), data: `${frame(3).data}\n` });
  sink.publishAudio({
    ...audio,
    frames: 2_000,
    byteLength: 8_000,
    data: Buffer.alloc(8_000).toString("base64"),
  });
  sink.publishFrame(frame(4));
  sink.publishAudio(audio);
  await vi.waitFor(() => expect(v.messages.at(-1)).toMatchObject({ kind: "audio" }));
  expect(v.messages.map((m) => m.kind)).toEqual(["session", "frame", "audio"]);
  const late = await viewer(p.viewerUrl, a, grant.grant);
  await vi.waitFor(() => expect(late.messages.map((m) => m.kind)).toEqual(["session", "frame"]));
  now += 10_001;
  expect(await p.client.status()).toEqual([]);
  await Promise.all([v.closed, late.closed]);
  expect(v.messages.at(-1)).toMatchObject({ kind: "stopped", reason: "expired" });
  const ended = await viewer(p.viewerUrl, a, grant.grant);
  expect(await ended.closed).toBe(4403);
});

it("bounds share, admission and viewer capacity and drops oversized viewer updates", async () => {
  const p = await plane({
    maxShares: 1,
    maxGrantsPerShare: 1,
    hubOptions: { maxViewers: 1, maxBufferedBytes: 1_000 },
  });
  const a = await p.client.start({ scope: scope("A"), source });
  await expect(p.client.start({ scope: scope("B"), source })).rejects.toMatchObject({ outcome: "refused" });
  const g = await p.client.grant(a);
  await expect(p.client.grant(a)).rejects.toMatchObject({ outcome: "refused" });
  const v = await viewer(p.viewerUrl, a, g.grant);
  await vi.waitFor(() => expect(v.messages.map((m) => m.kind)).toEqual(["session"]));
  const overCap = await viewer(p.viewerUrl, a, g.grant);
  await overCap.closed;
  expect(overCap.messages).toEqual([]);
  const sink = p.client.sink(a);
  await vi.waitFor(() => expect(sink.connected).toBe(true));
  sink.publishOverlay({
    schemaVersion: 2,
    sequence: 1,
    objective: "a".repeat(256),
    intent: "b".repeat(256),
    monologue: "c".repeat(256),
    effect: "d".repeat(256),
    updatedAt: new Date().toISOString(),
  });
  sink.publishStatus({ schemaVersion: 2, phase: "thinking", updatedAt: new Date().toISOString() });
  await vi.waitFor(() => expect(v.messages.at(-1)).toMatchObject({ kind: "status" }));
  expect(v.messages.map((m) => m.kind)).toEqual(["session", "status"]);
  expect(p.shares.stats()[0]).toMatchObject({ droppedUpdateCount: 1, viewerCount: 1 });
});

it("bounds real producer socket buffering for media, status and overlays", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((done) => server.once("listening", done));
  cleanup.push(async () => {
    for (const s of server.clients) s.terminate();
    await new Promise<void>((done) => server.close(() => done()));
  });
  server.on("connection", (s) => (s as unknown as { _socket: { pause(): void } })._socket.pause());
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing socket address");
  let socket: WebSocket | undefined;
  const session: ActivityShareSession = {
    shareId: "e89ddcc6-7ddb-4a2f-83e2-649c6073f8cb",
    generation: 1,
    scope: scope("A"),
    source,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };
  const sink = createActivityShareSink({
    url: `ws://127.0.0.1:${address.port}`,
    token: "test",
    session,
    maxBufferedBytes: 4_096,
    connect: (url) => {
      socket = new WebSocket(url);
      return socket;
    },
  });
  cleanup.push(() => {
    sink.close();
    socket?.terminate();
  });
  await vi.waitFor(() => expect(sink.connected).toBe(true));
  const status = {
    schemaVersion: 2 as const,
    phase: "thinking" as const,
    updatedAt: new Date().toISOString(),
  };
  const overlay = {
    schemaVersion: 2 as const,
    sequence: 1,
    objective: null,
    intent: null,
    monologue: "x".repeat(256),
    effect: null,
    updatedAt: new Date().toISOString(),
  };
  for (let i = 0; i < 40_000; i++) {
    sink.publishFrame(frame(i));
    sink.publishStatus(status);
    sink.publishOverlay({ ...overlay, sequence: i });
  }
  expect(sink.droppedFrameCount).toBeGreaterThan(0);
  expect(sink.droppedMessageCount).toBeGreaterThan(sink.droppedFrameCount);
  expect(socket!.bufferedAmount).toBeLessThanOrEqual(4_096);
});
