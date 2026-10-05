import type { ActivityShareSession } from "@clankie/interactive-environment";
import { afterEach, expect, it, vi } from "vitest";
import { RenderedSurfaceHub } from "../../../apps/discord-activity/src/frame-hub.ts";
import { createFrameProducerServer } from "../../../apps/discord-activity/src/producer.ts";
import { ActivityShareRegistry } from "../../../apps/discord-activity/src/share-registry.ts";
import { createActivityShareClient, createActivityShareFrameSink } from "../src/activity-share-client.ts";
import { createHash } from "node:crypto";

const controlToken = "lifecycle-control-secret";
const scope = (guildId = "guild") => ({
  tenantId: "tenant",
  installationId: "installation",
  guildId,
  channelId: "channel",
});
const source = { kind: "image" as const, id: "artifact", title: "Published image" };
const cleanup: (() => Promise<void> | void)[] = [];
const releaseResponses: (() => void)[] = [];

afterEach(async () => {
  for (const release of releaseResponses.splice(0)) release();
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Delay a real HTTP response after the private listener has applied it. */
function holdResponse(path: string) {
  let release!: () => void;
  const released = new Promise<void>((done) => {
    release = done;
  });
  releaseResponses.push(release);
  let held = false;
  const requests: { method: string; path: string }[] = [];
  const bridge: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const pathname = new URL(request.url).pathname;
    requests.push({ method: request.method, path: pathname });
    const response = await fetch(request);
    if (!held && request.method === "POST" && pathname === path) {
      held = true;
      await released;
    }
    return response;
  };
  return {
    fetch: bridge,
    requests,
    release,
    waitUntilHeld: () => vi.waitFor(() => expect(held).toBe(true), { timeout: 5_000 }),
  };
}

async function privatePlane(
  options: {
    fetch?: typeof fetch;
    maxCachedShares?: number;
    onSessionEnded?: (session: ActivityShareSession) => void;
  } = {},
) {
  const shares = new ActivityShareRegistry();
  const server = createFrameProducerServer({ shares, hub: new RenderedSurfaceHub(), token: controlToken });
  const port = await server.listen(0);
  cleanup.push(() => server.close());
  const url = `http://127.0.0.1:${port}`;
  const client = createActivityShareClient({ url, token: controlToken, ...options });
  cleanup.push(() => client.close());
  return { shares, client, url };
}

it("keeps a late applied start uncertain after client close, with the real identity and no replay", async () => {
  const held = holdResponse("/shares");
  const { client, shares } = await privatePlane({ fetch: held.fetch });
  const pending = client.start({ scope: scope(), source }).catch((error: unknown) => error);
  await held.waitUntilHeld();
  const actual = shares.list().sessions[0]!;
  expect(actual).toMatchObject({ generation: 1, scope: scope(), source });

  client.close();
  held.release();
  expect(await pending).toMatchObject({
    name: "ActivityShareRequestError",
    operation: "start",
    outcome: "uncertain",
    shareId: actual.shareId,
    generation: actual.generation,
  });
  expect(() => client.sink(actual)).toThrow("client is closed");
  await expect(client.start({ scope: scope("another-guild"), source })).rejects.toMatchObject({
    outcome: "refused",
  });
  expect(held.requests).toEqual([{ method: "POST", path: "/shares" }]);
  expect(shares.list().sessions).toEqual([actual]);
});

it("preserves its cached authority when the caller mutates a returned session", async () => {
  const { client, shares } = await privatePlane();
  const returned = await client.start({ scope: scope(), source });
  const original = structuredClone(returned);
  returned.scope.tenantId = "foreign-tenant";
  returned.source.title = "Changed by caller";
  returned.generation += 1;
  expect(() => client.sink(returned)).toThrow("foreign, expired, or replaced");
  const sink = client.sink(original);
  await vi.waitFor(() => expect(sink.connected).toBe(true), { timeout: 5_000 });
  expect(shares.list().sessions).toEqual([original]);
});

it("reserves cache capacity before concurrent dispatch and reconciles externally stopped capabilities", async () => {
  const held = holdResponse("/shares");
  const { client, shares, url } = await privatePlane({ fetch: held.fetch, maxCachedShares: 1 });
  const pending = client.start({ scope: scope(), source });
  await held.waitUntilHeld();
  await expect(client.start({ scope: scope("another-guild"), source })).rejects.toMatchObject({
    operation: "start",
    outcome: "refused",
  });
  expect(held.requests).toEqual([{ method: "POST", path: "/shares" }]);
  expect(shares.list().sessions).toHaveLength(1);
  held.release();
  const session = await pending;

  const stopped = await fetch(`${url}/shares/${session.shareId}/stop`, {
    method: "POST",
    headers: { authorization: `Bearer ${controlToken}`, "content-type": "application/json" },
    body: JSON.stringify({ generation: session.generation }),
  });
  expect(stopped.ok).toBe(true);
  expect(await client.status()).toEqual([]);
  const replacement = await client.start({ scope: scope("another-guild"), source });
  expect(shares.list().sessions).toEqual([replacement]);
});

it("refuses overlapping same-share switch and stop before dispatching another mutation", async () => {
  const { client: initial, shares, url } = await privatePlane();
  const session = await initial.start({ scope: scope(), source });
  const path = `/shares/${session.shareId}/switch`;
  const held = holdResponse(path);
  const client = createActivityShareClient({ url, token: controlToken, fetch: held.fetch });
  cleanup.push(() => client.close());
  const nextSource = { kind: "demo" as const, id: "demo", title: "Authored demo" };
  const pending = client.switchSource(session, nextSource);
  await held.waitUntilHeld();
  const applied = (await client.status())[0] as ActivityShareSession;
  expect(applied).toMatchObject({ shareId: session.shareId, generation: 2, source: nextSource });

  await expect(client.stop(applied)).rejects.toMatchObject({ operation: "stop", outcome: "refused" });
  await expect(client.switchSource(applied, source)).rejects.toMatchObject({
    operation: "switch",
    outcome: "refused",
  });
  expect(held.requests.filter((request) => request.method === "POST")).toEqual([{ method: "POST", path }]);
  expect(shares.list().sessions).toEqual([applied]);

  held.release();
  const switched = await pending;
  expect(switched).toEqual(applied);
  await client.stop(switched);
  expect(await client.status()).toEqual([]);
});

it("streams an authorized legacy producer through the private viewer client and releases admission on abort", async () => {
  const ended: ActivityShareSession[] = [];
  const { client, shares } = await privatePlane({ onSessionEnded: (session) => ended.push(session) });
  const session = await client.start({
    scope: scope(),
    source: { kind: "demo", id: "authored-demo", title: "Authored demo" },
  });
  await expect(client.openViewer(session, "not-a-grant")).rejects.toMatchObject({
    operation: "viewer",
    outcome: "refused",
  });
  const grant = await client.grant(session);
  const abort = new AbortController();
  const response = await client.openViewer(session, grant.grant, abort.signal);
  expect(response.headers.get("content-type")).toBe("application/x-ndjson");
  const reader = response.body!.getReader();
  cleanup.push(async () => {
    abort.abort();
    await reader.cancel().catch(() => undefined);
  });
  const initial = await reader.read();
  expect(JSON.parse(Buffer.from(initial.value!).toString())).toEqual({ kind: "session", session });
  const sink = createActivityShareFrameSink(client.sink(session));
  await vi.waitFor(() => expect(sink.connected).toBe(true));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
    "base64",
  );
  sink.publishFrame({
    schemaVersion: 1,
    surface: "gba_emulator",
    sequence: 1,
    frame: 42,
    width: 1,
    height: 1,
    encoding: "png",
    data: png.toString("base64"),
    byteLength: png.length,
    sha256: createHash("sha256").update(png).digest("hex"),
    capturedAt: new Date().toISOString(),
  });
  const next = JSON.parse(Buffer.from((await reader.read()).value!).toString());
  expect(next).toMatchObject({
    kind: "frame",
    shareId: session.shareId,
    generation: 1,
    frame: { schemaVersion: 2, frame: 42 },
  });
  expect(next.frame).not.toHaveProperty("surface");
  const pending = reader.read();
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(shares.stats()[0]!.viewerCount).toBe(0));
  sink.close();
  expect(ended).toEqual([session]);
  await vi.waitFor(async () => expect(await client.status()).toEqual([]));
});
