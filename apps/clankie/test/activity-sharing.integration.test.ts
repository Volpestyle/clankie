import { serve } from "@hono/node-server";
import { mintOperatorToken } from "@clankie/credential-broker";
import { ActivityShareFrameSchema, type ActivityShareSession } from "@clankie/interactive-environment";
import type { ActivityFrameSink } from "@clankie/rendered-surface-client";
import {
  createActivityFrameSink,
  createActivityShareClient,
  createActivityShareSink,
} from "@clankie/rendered-surface-client";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { RenderedSurfaceHub } from "../../discord-activity/src/frame-hub.ts";
import { createFrameProducerServer } from "../../discord-activity/src/producer.ts";
import { createDiscordActivityServer } from "../../discord-activity/src/server.ts";
import { ActivityShareRegistry } from "../../discord-activity/src/share-registry.ts";
import { runShareCommand } from "../../tui/src/command/share.ts";
import { ActivitySharing, type ActivitySharingOptions } from "../src/activity-sharing.ts";
import { createActivityArtifactSources } from "../src/activity-artifact-source.ts";
import { ActivityPlaySource } from "../src/activity-play-source.ts";
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

async function ownerPlane(
  p: Awaited<ReturnType<typeof plane>>,
  options: Partial<ActivitySharingOptions> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "clankie-share-owner-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "view.png"), PNG);
  const files = new DeliveredFileStore(join(root, "artifacts"));
  const artifact = await files.publish({ conversationId: "owner", sourceRoot: root, path: "view.png" });
  const sharing = new ActivitySharing({
    files,
    token: async () => "control-secret",
    url: p.producerUrl,
    ...options,
  });
  const token = mintOperatorToken();
  const service = await createClankieApp({
    captain: createStubCaptain(),
    activitySharing: sharing,
    eventLogPath: join(root, "events.jsonl"),
    authenticateOperator: async (req) =>
      req.headers.get("authorization") === `Bearer ${token}` ? { operatorId: "owner" } : undefined,
  });
  const http = serve({ fetch: (req) => service.app.fetch(req), hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((done) => http.once("listening", done));
  cleanup.push(async () => {
    service.close();
    await new Promise<void>((done) => http.close(() => done()));
  });
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("missing owner fixture address");
  const host = `http://127.0.0.1:${address.port}`;
  return {
    root,
    files,
    artifact,
    sharing,
    command: (input: unknown) =>
      runShareCommand(["request", JSON.stringify(input)], {
        host,
        env: { CLANKIE_OPERATOR_TOKEN: token },
      }),
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
  // Admission expires at the share deadline and closes media before another
  // envelope can cross, even if the share's expiry notification is pending.
  expect(await Promise.all([v.closed, late.closed])).toEqual([4403, 4403]);
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

it.each(["share", "public"] as const)(
  "bounds real %s producer socket buffering for media, status and overlays",
  async (kind) => {
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
    const options = {
      url: `ws://127.0.0.1:${address.port}`,
      token: "test",
      session,
      maxBufferedBytes: 4_096,
      connect: (url: string) => {
        socket = new WebSocket(url);
        return socket;
      },
    };
    const sink = kind === "share" ? createActivityShareSink(options) : createActivityFrameSink(options);
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
      if ("droppedMessageCount" in sink) {
        sink.publishFrame(frame(i));
        sink.publishStatus(status);
        sink.publishOverlay({ ...overlay, sequence: i });
      } else {
        sink.publishFrame({ ...frame(i), schemaVersion: 1, surface: "gba_emulator", frame: i });
        sink.publishStatus({ ...status, schemaVersion: 1, surface: "gba_emulator" });
        sink.publishOverlay({ ...overlay, sequence: i, surface: "gba_emulator" });
      }
    }
    expect(sink.droppedFrameCount).toBeGreaterThan(0);
    if ("droppedMessageCount" in sink)
      expect(sink.droppedMessageCount).toBeGreaterThan(sink.droppedFrameCount);
    expect(socket!.bufferedAmount).toBeLessThanOrEqual(4_096);
  },
);

it("reconciles applied starts and switches after lost private receipts without replaying or exposing foreign installations", async () => {
  const p = await plane();
  let losePath: string | undefined = "/shares";
  const writes: string[] = [];
  const bridge: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "POST") writes.push(path);
    const response = await fetch(request);
    if (request.method === "POST" && path === losePath) {
      losePath = undefined;
      await response.arrayBuffer();
      throw new TypeError("Lost applied private response");
    }
    return response;
  };
  const f = await ownerPlane(p, {
    tenantId: "customer",
    installationId: "current-install",
    authorizeDestination: async () => true,
    fetch: bridge,
  });
  const foreign = await p.client.start({ scope: scope("foreign", "99"), source });
  const restored = await p.client.start({
    scope: { tenantId: "customer", installationId: "old-install", guildId: "98", channelId: "97" },
    source,
  });
  const start = {
    action: "image",
    conversationId: "owner",
    artifactId: f.artifact.artifactId,
    guildId: "1",
    channelId: "2",
  };
  expect(await f.command(start)).toMatchObject({
    ok: false,
    body: { outcome: "uncertain", operation: "start" },
  });
  const first = (await f.command({ action: "list" })).body as { sessions: ActivityShareSession[] };
  expect(first.sessions).toHaveLength(1);
  const orphan = first.sessions[0]!;
  expect(orphan.scope).toEqual({
    tenantId: "customer",
    installationId: "current-install",
    guildId: "1",
    channelId: "2",
  });
  expect(writes).toEqual(["/shares"]);
  expect((await f.command({ action: "stop", shareId: foreign.shareId, generation: 1 })).ok).toBe(false);
  expect(await f.command({ action: "stop", shareId: orphan.shareId, generation: 1 })).toEqual({
    ok: true,
    body: { stopped: true },
  });
  const created = (await f.command(start)).body as { session: ActivityShareSession };
  losePath = `/shares/${created.session.shareId}/switch`;
  expect(
    await f.command({
      action: "switch",
      shareId: created.session.shareId,
      generation: 1,
      conversationId: "owner",
      artifactId: f.artifact.artifactId,
    }),
  ).toMatchObject({ ok: false, body: { outcome: "uncertain", operation: "switch" } });
  const switched = ((await f.command({ action: "list" })).body as { sessions: ActivityShareSession[] })
    .sessions;
  expect(switched).toHaveLength(1);
  expect(switched[0]).toMatchObject({ shareId: created.session.shareId, generation: 2 });
  expect(writes.filter((path) => path.endsWith("/switch"))).toHaveLength(1);
  expect((await f.command({ action: "stop", shareId: created.session.shareId, generation: 1 })).ok).toBe(
    false,
  );
  expect((await f.command({ action: "stop", shareId: created.session.shareId, generation: 2 })).ok).toBe(
    true,
  );
  expect((await f.command({ action: "list" })).body).toEqual({ sessions: [] });
  expect(await p.client.status()).toEqual([foreign, restored]);
});

it("attaches an existing game producer, switches to an exact image, returns one-attempt receipts and releases busy on producer loss", async () => {
  const p = await plane();
  const busy: boolean[] = [];
  const effects: { action: string; session: ActivityShareSession; requestId: string }[] = [];
  let game: ActivityFrameSink | undefined;
  let detached = 0;
  let permit = true;
  let loseLaunch = false;
  const f = await ownerPlane(p, {
    tenantId: "customer",
    installationId: "current-install",
    onBusyChange: (active) => busy.push(active),
    authorizeDestination: async (destination) =>
      permit && destination.guildId === "1" && destination.channelId === "2",
    sources: {
      resolve: async (id) =>
        id === "existing-game"
          ? {
              source,
              attach: (sink) => {
                game = sink;
                return () => {
                  detached += 1;
                };
              },
            }
          : undefined,
    },
    launch: async (session, requestId) => {
      effects.push({ action: "launch", session, requestId });
      if (loseLaunch) throw new TypeError("Lost launch response");
      return { outcome: "confirmed", receiptId: requestId, session, inviteUrl: "https://discord.gg/fixture" };
    },
    stop: async (session, requestId) => {
      effects.push({ action: "stop", session, requestId });
      return { outcome: "confirmed", receiptId: requestId, session };
    },
  });
  permit = false;
  expect(
    (await f.command({ action: "start", sourceId: "existing-game", guildId: "1", channelId: "2" })).ok,
  ).toBe(false);
  expect(await p.client.status()).toEqual([]);
  expect(effects).toEqual([]);
  permit = true;
  const created = (
    await f.command({ action: "start", sourceId: "existing-game", guildId: "1", channelId: "2" })
  ).body as { session: ActivityShareSession; receipt: { outcome: string } };
  expect(created.receipt.outcome).toBe("confirmed");
  expect(created.session.source.kind).toBe("game");
  const otherRoom = await p.client.start({
    scope: { tenantId: "customer", installationId: "current-install", guildId: "7", channelId: "8" },
    source,
  });
  expect((await f.command({ action: "list" })).body).toEqual({ sessions: [created.session] });
  expect((await f.command({ action: "stop", shareId: otherRoom.shareId, generation: 1 })).ok).toBe(false);
  const grant = (await f.command({ action: "grant", shareId: created.session.shareId, generation: 1 }))
    .body as { grant: string };
  const v = await viewer(p.viewerUrl, created.session, grant.grant);
  await expect(
    f.sharing.openViewer(
      { ...created.session, scope: { ...created.session.scope, tenantId: "foreign" } },
      async () => true,
    ),
  ).rejects.toThrow("activity_destination_refused");
  await expect(f.sharing.openViewer(created.session, async () => false)).rejects.toThrow(
    "operator_authentication_required",
  );
  const streamAbort = new AbortController();
  const stream = await f.sharing.openViewer(created.session, async () => true, streamAbort.signal);
  const reader = stream.body!.getReader();
  cleanup.push(async () => {
    streamAbort.abort();
    await reader.cancel().catch(() => undefined);
  });
  expect(JSON.parse(Buffer.from((await reader.read()).value!).toString())).toEqual({
    kind: "session",
    session: created.session,
  });
  game!.publishFrame({ ...frame(1), schemaVersion: 1, surface: "gba_emulator", frame: 42 });
  game!.publishAudio({
    schemaVersion: 1,
    surface: "gba_emulator",
    sequence: 1,
    frame: 42,
    encoding: "pcm_s16le",
    sampleRate: 8_000,
    channels: 2,
    frames: 80,
    data: Buffer.alloc(320).toString("base64"),
    byteLength: 320,
    capturedAt: new Date().toISOString(),
  });
  await vi.waitFor(() =>
    expect(v.messages.map((message) => message.kind)).toEqual(["session", "frame", "audio"]),
  );
  expect(v.messages[1]).toMatchObject({ generation: 1, frame: { schemaVersion: 2, frame: 42 } });
  expect(v.messages[1]!.frame).not.toHaveProperty("surface");
  const streamed = Buffer.from((await reader.read()).value!)
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(streamed[0]).toMatchObject({ kind: "frame", shareId: created.session.shareId, generation: 1 });
  expect(JSON.stringify(streamed)).not.toContain("control-secret");
  streamAbort.abort();
  await reader.cancel().catch(() => undefined);
  const oldGame = game!;
  const switched = (
    await f.command({
      action: "switch",
      shareId: created.session.shareId,
      generation: 1,
      conversationId: "owner",
      artifactId: f.artifact.artifactId,
    })
  ).body as { session: ActivityShareSession; receipt: { outcome: string } };
  expect(switched.receipt.outcome).toBe("confirmed");
  await vi.waitFor(() =>
    expect(v.messages.at(-1)).toMatchObject({ generation: 2, frame: { sha256: f.artifact.sha256 } }),
  );
  expect(v.messages.at(-1)!.frame).not.toHaveProperty("frame");
  expect(detached).toBe(1);
  oldGame.publishFrame({ ...frame(500), schemaVersion: 1, surface: "gba_emulator", frame: 500 });
  expect(
    (await f.command({ action: "stop", shareId: created.session.shareId, generation: 2 })).body,
  ).toMatchObject({ stopped: true, receipt: { outcome: "confirmed" } });
  await v.closed;
  expect(effects.map(({ action, session }) => [action, session.generation])).toEqual([
    ["launch", 1],
    ["launch", 2],
    ["stop", 2],
  ]);
  expect(new Set(effects.map(({ requestId }) => requestId)).size).toBe(3);
  expect(busy.at(-1)).toBe(false);
  loseLaunch = true;
  const uncertain = (
    await f.command({ action: "start", sourceId: "existing-game", guildId: "1", channelId: "2" })
  ).body as { session: ActivityShareSession; receipt: { outcome: string } };
  expect(uncertain.receipt.outcome).toBe("uncertain");
  expect(effects.filter(({ action }) => action === "launch")).toHaveLength(3);
  expect(busy.at(-1)).toBe(true);
  game!.close();
  await vi.waitFor(() => expect(busy.at(-1)).toBe(false));
  expect(detached).toBe(2);
  await vi.waitFor(async () => expect((await f.command({ action: "list" })).body).toEqual({ sessions: [] }));
});

it("decodes real delivered MP4 audio and GIF animation, fences switches and cleans its owned media on stop, TTL, EOF and shutdown", async () => {
  const p = await plane();
  const busy: boolean[] = [];
  let artifacts: ReturnType<typeof createActivityArtifactSources>;
  const f = await ownerPlane(p, {
    tenantId: "customer",
    installationId: "current-install",
    authorizeDestination: async () => true,
    onBusyChange: (active) => busy.push(active),
    sources: { resolve: (id) => artifacts.resolve(id) },
  });
  const decoderRoot = join(f.root, "decoders");
  artifacts = createActivityArtifactSources({ files: f.files, temporaryRoot: decoderRoot });
  const run = promisify(execFile);
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-threads",
      "1",
      "-filter_threads",
      "1",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=32x32:rate=5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=32000",
      "-t",
      "2",
      "-c:v",
      "mpeg4",
      "-q:v",
      "4",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      join(f.root, "demo.mp4"),
    ],
    { timeout: 20_000, maxBuffer: 16 * 1024 },
  );
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-threads",
      "1",
      "-filter_threads",
      "1",
      "-i",
      join(f.root, "demo.mp4"),
      "-t",
      "1",
      "-vf",
      "fps=5,scale=32:32",
      "-an",
      join(f.root, "animation.gif"),
    ],
    { timeout: 20_000, maxBuffer: 16 * 1024 },
  );
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-threads",
      "1",
      "-f",
      "lavfi",
      "-i",
      "color=size=32x32:rate=1",
      "-t",
      "121",
      "-c:v",
      "mpeg4",
      join(f.root, "too-long.mp4"),
    ],
    { timeout: 20_000, maxBuffer: 16 * 1024 },
  );
  await writeFile(join(f.root, "invalid.mp4"), PNG);
  const conversationId = randomUUID();
  const video = await f.files.publish({
    conversationId,
    sourceRoot: f.root,
    path: "demo.mp4",
    mediaType: "video/mp4",
  });
  const gif = await f.files.publish({
    conversationId,
    sourceRoot: f.root,
    path: "animation.gif",
    mediaType: "image/gif",
  });
  const png = await f.files.publish({ conversationId, sourceRoot: f.root, path: "view.png" });
  for (const path of ["too-long.mp4", "invalid.mp4"]) {
    const refused = await f.files.publish({
      conversationId,
      sourceRoot: f.root,
      path,
      mediaType: "video/mp4",
    });
    expect(
      (
        await f.command({
          action: "start",
          sourceId: `artifact:${conversationId}:${refused.artifactId}`,
          guildId: "1",
          channelId: "2",
        })
      ).ok,
    ).toBe(false);
    expect(await p.client.status()).toEqual([]);
    expect(await readdir(decoderRoot)).toEqual([]);
  }
  const videoId = `artifact:${conversationId}:${video.artifactId}`;
  const gifId = `artifact:${conversationId}:${gif.artifactId}`;
  const imageId = `artifact:${conversationId}:${png.artifactId}`;
  expect(
    (
      await f.command({
        action: "start",
        sourceId: `artifact:${randomUUID()}:${video.artifactId}`,
        guildId: "1",
        channelId: "2",
      })
    ).ok,
  ).toBe(false);
  expect(
    (await f.command({ action: "start", sourceId: "http://127.0.0.1/capture", guildId: "1", channelId: "2" }))
      .ok,
  ).toBe(false);
  expect(await p.client.status()).toEqual([]);
  const created = (await f.command({ action: "start", sourceId: videoId, guildId: "1", channelId: "2" }))
    .body as { session: ActivityShareSession };
  expect(created.session.source).toMatchObject({ kind: "demo", id: videoId });
  const grant = (await f.command({ action: "grant", shareId: created.session.shareId, generation: 1 }))
    .body as { grant: string };
  const v = await viewer(p.viewerUrl, created.session, grant.grant);
  await vi.waitFor(
    () => {
      expect(v.messages.filter((message) => message.kind === "frame").length).toBeGreaterThanOrEqual(2);
      expect(v.messages.some((message) => message.kind === "audio")).toBe(true);
    },
    { timeout: 5_000 },
  );
  for (const message of v.messages) {
    if (message.kind === "frame") {
      expect(message.frame.byteLength).toBeLessThanOrEqual(256 * 1024);
      expect(message.frame).not.toHaveProperty("surface");
      expect(message.frame).not.toHaveProperty("frame");
    }
    if (message.kind === "audio")
      expect(message.audio.frames / message.audio.sampleRate).toBeLessThanOrEqual(0.2);
  }
  expect(await readdir(decoderRoot)).toHaveLength(1);
  const switched = (
    await f.command({ action: "switch", shareId: created.session.shareId, generation: 1, sourceId: gifId })
  ).body as { session: ActivityShareSession };
  expect(switched.session.source.kind).toBe("animation");
  await vi.waitFor(
    () =>
      expect(v.messages.some((message) => message.kind === "frame" && message.generation === 2)).toBe(true),
    { timeout: 5_000 },
  );
  const image = (
    await f.command({ action: "switch", shareId: created.session.shareId, generation: 2, sourceId: imageId })
  ).body as { session: ActivityShareSession };
  expect(image.session.source.kind).toBe("image");
  await vi.waitFor(() =>
    expect(v.messages.at(-1)).toMatchObject({ kind: "frame", generation: 3, frame: { sha256: png.sha256 } }),
  );
  expect((await f.command({ action: "stop", shareId: created.session.shareId, generation: 3 })).ok).toBe(
    true,
  );
  await v.closed;
  await vi.waitFor(async () => expect(await readdir(decoderRoot)).toEqual([]));
  expect(busy.at(-1)).toBe(false);
  const expiring = (
    await f.command({ action: "start", sourceId: videoId, guildId: "1", channelId: "2", ttlMs: 150 })
  ).body as { session: ActivityShareSession };
  expect(expiring.session.source.kind).toBe("demo");
  await vi.waitFor(
    async () => {
      expect((await f.command({ action: "list" })).body).toEqual({ sessions: [] });
      expect(await readdir(decoderRoot)).toEqual([]);
      expect(busy.at(-1)).toBe(false);
    },
    { timeout: 5_000 },
  );
  const finite = (await f.command({ action: "start", sourceId: gifId, guildId: "1", channelId: "2" }))
    .body as { session: ActivityShareSession };
  expect(finite.session.source.kind).toBe("animation");
  expect(busy.at(-1)).toBe(true);
  await vi.waitFor(
    async () => {
      expect(await p.client.status()).toEqual([]);
      expect(await readdir(decoderRoot)).toEqual([]);
      expect(busy.at(-1)).toBe(false);
    },
    { timeout: 5_000 },
  );
  const closing = (await f.command({ action: "start", sourceId: videoId, guildId: "1", channelId: "2" }))
    .body as { session: ActivityShareSession };
  expect(closing.session.source.kind).toBe("demo");
  expect(await readdir(decoderRoot)).toHaveLength(1);
  f.sharing.close();
  expect(busy.at(-1)).toBe(false);
  await vi.waitFor(
    async () => {
      expect(await p.client.status()).toEqual([]);
      expect(await readdir(decoderRoot)).toEqual([]);
    },
    { timeout: 5_000 },
  );
});

it("ends the scoped share and busy lease when the production play fanout closes its existing producer", async () => {
  const p = await plane();
  const play = new ActivityPlaySource();
  const producer = play.createSink("Existing game");
  cleanup.push(() => producer.close());
  const busy: boolean[] = [];
  const f = await ownerPlane(p, {
    tenantId: "customer",
    installationId: "current-install",
    authorizeDestination: async () => true,
    onBusyChange: (active) => busy.push(active),
    sources: { resolve: async (id) => play.resolve(id) },
  });
  const created = (await f.command({ action: "start", sourceId: "play", guildId: "1", channelId: "2" }))
    .body as { session: ActivityShareSession };
  expect(created.session.source).toMatchObject({ kind: "game", id: "play", title: "Existing game" });
  const grant = (await f.command({ action: "grant", shareId: created.session.shareId, generation: 1 }))
    .body as { grant: string };
  const v = await viewer(p.viewerUrl, created.session, grant.grant);
  producer.publishFrame({ ...frame(1), schemaVersion: 1, surface: "gba_emulator", frame: 55 });
  await vi.waitFor(() => expect(v.messages.at(-1)).toMatchObject({ kind: "frame", frame: { frame: 55 } }));
  expect(busy.at(-1)).toBe(true);
  producer.close();
  expect(busy.at(-1)).toBe(false);
  expect(play.resolve("play")).toBeUndefined();
  await v.closed;
  await vi.waitFor(async () => expect(await p.client.status()).toEqual([]));
  expect((await f.command({ action: "start", sourceId: "play", guildId: "1", channelId: "2" })).ok).toBe(
    false,
  );
});

it("plays exact delivered WAV and MP3 through scoped audio-only demos, switches generations and cleans on stop and expiry", async () => {
  const p = await plane();
  const busy: boolean[] = [];
  let artifacts: ReturnType<typeof createActivityArtifactSources>;
  const f = await ownerPlane(p, {
    tenantId: "customer",
    installationId: "current-install",
    authorizeDestination: async () => true,
    onBusyChange: (active) => busy.push(active),
    sources: { resolve: (id) => artifacts.resolve(id) },
  });
  const decoderRoot = join(f.root, "audio-decoders");
  artifacts = createActivityArtifactSources({ files: f.files, temporaryRoot: decoderRoot });
  const run = promisify(execFile);
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-threads",
      "1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=16000",
      "-t",
      "3",
      "-c:a",
      "pcm_s16le",
      join(f.root, "sound.wav"),
    ],
    { timeout: 20_000, maxBuffer: 16 * 1024 },
  );
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-threads",
      "1",
      "-i",
      join(f.root, "sound.wav"),
      "-c:a",
      "libmp3lame",
      join(f.root, "sound.mp3"),
    ],
    { timeout: 20_000, maxBuffer: 16 * 1024 },
  );
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-threads",
      "1",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=sample_rate=16000:channel_layout=mono",
      "-t",
      "121",
      "-c:a",
      "pcm_s16le",
      join(f.root, "too-long.wav"),
    ],
    { timeout: 20_000, maxBuffer: 16 * 1024 },
  );
  const conversationId = randomUUID();
  const wav = await f.files.publish({
    conversationId,
    sourceRoot: f.root,
    path: "sound.wav",
    mediaType: "audio/wav",
  });
  const mp3 = await f.files.publish({
    conversationId,
    sourceRoot: f.root,
    path: "sound.mp3",
    mediaType: "audio/mpeg",
  });
  const long = await f.files.publish({
    conversationId,
    sourceRoot: f.root,
    path: "too-long.wav",
    mediaType: "audio/wav",
  });
  expect(
    (
      await f.command({
        action: "start",
        sourceId: `artifact:${conversationId}:${long.artifactId}`,
        guildId: "1",
        channelId: "2",
      })
    ).ok,
  ).toBe(false);
  expect(await p.client.status()).toEqual([]);
  expect(await readdir(decoderRoot)).toEqual([]);
  const wavId = `artifact:${conversationId}:${wav.artifactId}`;
  const mp3Id = `artifact:${conversationId}:${mp3.artifactId}`;
  const created = (await f.command({ action: "start", sourceId: wavId, guildId: "1", channelId: "2" }))
    .body as { session: ActivityShareSession };
  expect(created.session.source).toMatchObject({ kind: "demo", title: "sound.wav" });
  const grant = (await f.command({ action: "grant", shareId: created.session.shareId, generation: 1 }))
    .body as { grant: string };
  const v = await viewer(p.viewerUrl, created.session, grant.grant);
  await vi.waitFor(() => {
    expect(v.messages.some((message) => message.kind === "audio" && message.generation === 1)).toBe(true);
    expect(v.messages.some((message) => message.kind === "status" && message.status.phase === "acting")).toBe(
      true,
    );
  });
  const switched = (
    await f.command({ action: "switch", shareId: created.session.shareId, generation: 1, sourceId: mp3Id })
  ).body as { session: ActivityShareSession };
  expect(switched.session.source).toMatchObject({ kind: "demo", title: "sound.mp3" });
  await vi.waitFor(() =>
    expect(v.messages.some((message) => message.kind === "audio" && message.generation === 2)).toBe(true),
  );
  expect(v.messages.some((message) => message.kind === "frame")).toBe(false);
  const packets = v.messages.filter((message) => message.kind === "audio");
  expect(
    packets.some((message) => Buffer.from(message.audio.data, "base64").some((byte) => byte !== 0)),
  ).toBe(true);
  for (const { audio } of packets) {
    expect(audio).toMatchObject({
      schemaVersion: 2,
      sampleRate: 32_000,
      channels: 2,
      frames: 640,
      byteLength: 2560,
    });
    expect(audio).not.toHaveProperty("surface");
    expect(audio).not.toHaveProperty("frame");
  }
  expect((await f.command({ action: "stop", shareId: created.session.shareId, generation: 2 })).ok).toBe(
    true,
  );
  await v.closed;
  await vi.waitFor(async () => expect(await readdir(decoderRoot)).toEqual([]));
  expect(busy.at(-1)).toBe(false);
  expect(
    (await f.command({ action: "start", sourceId: mp3Id, guildId: "1", channelId: "2", ttlMs: 150 })).ok,
  ).toBe(true);
  await vi.waitFor(async () => {
    expect(await p.client.status()).toEqual([]);
    expect(await readdir(decoderRoot)).toEqual([]);
    expect(busy.at(-1)).toBe(false);
  });
});
