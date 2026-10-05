import { expect, it, vi } from "vitest";
import { createActivityShareClient } from "../../../packages/rendered-surface-client/src/activity-share-client.ts";
import { RenderedSurfaceHub } from "../src/frame-hub.ts";
import { createFrameProducerServer } from "../src/producer.ts";
import { createDiscordActivityServer } from "../src/server.ts";
import { ActivityShareRegistry } from "../src/share-registry.ts";
import { WebSocket } from "ws";

it("the authenticated HTTP media stream follows a switch and releases its slot on stop, cancellation and revocation", async () => {
  const shares = new ActivityShareRegistry();
  const hub = new RenderedSurfaceHub();
  const producer = createFrameProducerServer({ hub, shares, token: "private-control" });
  const activity = createDiscordActivityServer({ hub, shares });
  const port = await producer.listen(0),
    publicPort = await activity.listen(0);
  const client = createActivityShareClient({ url: `http://127.0.0.1:${port}`, token: "private-control" });
  const session = await client.start({
    scope: { tenantId: "t", installationId: "i", guildId: "g", channelId: "c" },
    source: { kind: "game", id: "firered", title: "FireRed" },
  });
  const grant = await client.grant(session);
  const url = `http://127.0.0.1:${port}/shares/${session.shareId}/viewer`;
  const request = (headers: Record<string, string>, token: string) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ generation: session.generation, grant: token }),
    });
  const sockets: WebSocket[] = [];
  try {
    expect((await request({}, grant.grant)).status).toBe(401);
    expect((await request({ authorization: "Bearer private-control" }, "invalid-grant")).status).toBe(403);
    const response = await client.openViewer(session, grant.grant);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(first.value).trim())).toEqual({ kind: "session", session });
    const changed = await client.switchSource(session, { kind: "demo", id: "demo", title: "Recorded demo" });
    const update = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(update.value).trim())).toEqual({
      kind: "session",
      session: changed,
    });
    await client.stop(changed);
    expect(JSON.parse(new TextDecoder().decode((await reader.read()).value).trim()).kind).toBe("stopped");
    expect((await reader.read()).done).toBe(true);
    const next = await client.start({ scope: session.scope, source: session.source });
    const nextGrant = await client.grant(next);
    const cancelled = new AbortController();
    const opened = await client.openViewer(next, nextGrant.grant, cancelled.signal);
    const pendingReader = opened.body!.getReader();
    await pendingReader.read();
    expect(shares.stats()[0]?.viewerCount).toBe(1);
    cancelled.abort();
    await pendingReader.cancel().catch(() => undefined);
    await vi.waitFor(() => expect(shares.stats()[0]?.viewerCount).toBe(0));
    const socket = new WebSocket(`ws://127.0.0.1:${publicPort}/shares/${next.shareId}/frames`);
    sockets.push(socket);
    await new Promise<void>((done) => socket.once("open", done));
    socket.send(JSON.stringify({ kind: "admit", grant: nextGrant.grant }));
    await vi.waitFor(() => expect(shares.stats()[0]?.viewerCount).toBe(1));
    const closure = new Promise<number>((done) => socket.once("close", done));
    shares.revokeGrant(next.shareId, nextGrant.grant);
    expect(await closure).toBe(4403);
    expect(shares.stats()[0]?.viewerCount).toBe(0);
  } finally {
    for (const socket of sockets) socket.terminate();
    await activity.close();
    await producer.close();
  }
});

it("grant expiry terminates an admitted socket and official mode rejects anonymous legacy media", async () => {
  const shares = new ActivityShareRegistry({ grantTtlMs: 120 });
  const hub = new RenderedSurfaceHub();
  const activity = createDiscordActivityServer({
    hub,
    shares,
    viewerMode: { mode: "official", applicationId: "90001" },
  });
  const port = await activity.listen(0);
  const result = shares.create(
    { tenantId: "t", installationId: "i", guildId: "g", channelId: "c" },
    { kind: "image", id: "image", title: "Image" },
  );
  const grant = shares.grant(result.session.shareId, 1);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/shares/${result.session.shareId}/frames`);
  const anonymous = new WebSocket(`ws://127.0.0.1:${port}/.proxy/frames`);
  anonymous.on("error", () => undefined);
  try {
    const denied = new Promise<void>((done) => anonymous.once("close", () => done()));
    const expired = new Promise<number>((done) => socket.once("close", done));
    await new Promise<void>((done) => socket.once("open", done));
    socket.send(JSON.stringify({ kind: "admit", grant: grant.grant }));
    await vi.waitFor(() => expect(shares.stats()[0]?.viewerCount).toBe(1));
    expect(await expired).toBe(4403);
    await denied;
    expect(shares.stats()[0]?.viewerCount).toBe(0);
  } finally {
    socket.terminate();
    anonymous.terminate();
    await activity.close();
  }
});

it("controller-authorized streams follow media beyond delegated grant expiry, while both modes remain bound to stop and share expiry", async () => {
  let now = Date.now();
  const shares = new ActivityShareRegistry({ now: () => now });
  const hub = new RenderedSurfaceHub();
  const producer = createFrameProducerServer({ hub, shares, token: "private-control" });
  const activity = createDiscordActivityServer({
    hub,
    shares,
    viewerMode: { mode: "official", applicationId: "90001" },
  });
  const port = await producer.listen(0);
  const publicPort = await activity.listen(0);
  const origin = `http://127.0.0.1:${port}`;
  const client = createActivityShareClient({ url: origin, token: "private-control" });
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  const buffered = new WeakMap<
    ReadableStreamDefaultReader<Uint8Array>,
    { text: string; decoder: TextDecoder }
  >();
  const next = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    let state = buffered.get(reader);
    if (state === undefined) {
      state = { text: "", decoder: new TextDecoder() };
      buffered.set(reader, state);
    }
    while (!state.text.includes("\n")) {
      const part = await reader.read();
      if (part.done) {
        expect(state.text).toBe("");
        return undefined;
      }
      state.text += state.decoder.decode(part.value, { stream: true });
    }
    const end = state.text.indexOf("\n");
    const line = state.text.slice(0, end);
    state.text = state.text.slice(end + 1);
    return JSON.parse(line);
  };
  const open = async (response: Response) => {
    const reader = response.body!.getReader();
    readers.push(reader);
    const first = await next(reader);
    expect(JSON.stringify(first)).not.toContain("private-control");
    expect(first.kind).toBe("session");
    return reader;
  };
  const session = await client.start({
    scope: { tenantId: "t", installationId: "i", guildId: "g", channelId: "c" },
    source: { kind: "image", id: "image", title: "Image" },
  });
  const url = `/shares/${session.shareId}/viewer`;
  const liveBody = JSON.stringify({ generation: 1, mode: "live" });
  const request = (base: string, body: string, authorized = false) =>
    fetch(`${base}${url}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorized ? { authorization: "Bearer private-control" } : {}),
      },
      body,
    });
  try {
    expect((await request(origin, liveBody)).status).toBe(401);
    expect((await request(`http://127.0.0.1:${publicPort}`, liveBody, true)).status).toBe(404);
    expect(
      (await request(origin, JSON.stringify({ generation: 1, mode: "live", grant: "not-a-grant" }), true))
        .status,
    ).toBe(400);
    await expect(client.openAuthorizedViewer({ ...session, generation: 2 })).rejects.toMatchObject({
      operation: "viewer",
      outcome: "refused",
    });
    const grant = await client.grant(session);
    expect(Date.parse(grant.expiresAt) - now).toBe(300_000);
    const delegated = await open(await client.openViewer(session, grant.grant));
    const live = await open(await client.openAuthorizedViewer(session));
    expect(shares.stats()[0]?.viewerCount).toBe(2);
    now += 300_001;
    await client.status();
    expect(await next(delegated)).toBeUndefined();
    expect(shares.stats()[0]?.viewerCount).toBe(1);
    const changed = await client.switchSource(session, { kind: "demo", id: "demo", title: "Demo" });
    expect(await next(live)).toEqual({
      kind: "session",
      session: changed,
    });
    const sink = client.sink(changed);
    await vi.waitFor(() => expect(sink.connected).toBe(true));
    sink.publishStatus({ schemaVersion: 2, phase: "acting", updatedAt: new Date().toISOString() });
    expect(await next(live)).toMatchObject({
      kind: "status",
      generation: 2,
    });
    const cancelling = new AbortController();
    const cancelled = await open(await client.openAuthorizedViewer(changed, cancelling.signal));
    expect(shares.stats()[0]?.viewerCount).toBe(2);
    cancelling.abort();
    await cancelled.cancel().catch(() => undefined);
    await vi.waitFor(() => expect(shares.stats()[0]?.viewerCount).toBe(1));
    const nextGrant = await client.grant(changed);
    const stoppedDelegate = await open(await client.openViewer(changed, nextGrant.grant));
    expect(await next(stoppedDelegate)).toMatchObject({ kind: "status", generation: 2 });
    await client.stop(changed);
    for (const reader of [live, stoppedDelegate]) {
      expect((await next(reader)).kind).toBe("stopped");
      expect(await next(reader)).toBeUndefined();
    }
    const expiring = await client.start({ scope: session.scope, source: session.source, ttlMs: 1_000 });
    const expiryGrant = await client.grant(expiring);
    const expiredDelegate = await open(await client.openViewer(expiring, expiryGrant.grant));
    const expiredLive = await open(await client.openAuthorizedViewer(expiring));
    now += 1_001;
    expect(await client.status()).toEqual([]);
    expect(await next(expiredDelegate)).toBeUndefined();
    expect(await next(expiredLive)).toBeUndefined();
  } finally {
    for (const reader of readers) await reader.cancel().catch(() => undefined);
    client.close();
    await activity.close();
    await producer.close();
  }
});
