import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat, symlink, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type Server } from "node:http";
import { serve } from "@hono/node-server";
import { afterEach, describe, expect, it } from "vitest";
import { LocalCompanionHandoffSchema, LocalCompanionSessionSchema } from "@clankie/protocol/local-companion";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { startLocalCompanionIssuer } from "../src/local-companion-issuer.ts";
import { LocalCompanionBoundary } from "../src/local-companion-boundary.ts";
import { deviceDoorwayFetch } from "../src/device-doorway.ts";
import { writeLocalCompanionHandoff } from "../../tui/bin/local-companion.ts";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "companion-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await chmod(dir, 0o755); // Match existing installed state roots; only companion is private.
  const key = randomBytes(32);
  const boundary = new LocalCompanionBoundary();
  let app: ClankieApp;
  const boot = async () => {
    app = await createClankieApp({
      captain: createStubCaptain(),
      eventLogPath: join(dir, "events.jsonl"),
      deviceSessionKey: key,
      modelDeviceSetup: { platform: "darwin", hosted: false },
      isLocalCompanionRequest: (request) => boundary.has(request),
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    });
  };
  await boot();
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: boundary.fetch((request) => app.app.fetch(request)),
  }) as Server;
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        app.close();
        server.close(() => resolve());
      }),
  );
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const issuer = await startLocalCompanionIssuer({
    stateRoot: dir,
    controlPlaneUrl: origin,
    boundary,
    fetch: (request) => app.app.fetch(request),
  });
  cleanups.push(() => issuer.close());
  const call = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const mint = async () =>
    (await call("/v1/pairing/local/offer", {}, { authorization: "Bearer owner" })).json();
  return {
    dir,
    origin,
    call,
    mint,
    app: () => app,
    restart: async () => {
      app.close();
      await boot();
    },
  };
}

describe("Mac companion local pairing boundary", () => {
  it("hands off privately, redeems once, reuses its durable device after reinstall/restart, and preserves revocation", async () => {
    const f = await fixture();
    const path = await writeLocalCompanionHandoff({
      env: { CLANKIE_STATE: f.dir },
      controlPlaneUrl: f.origin,
      operatorToken: "owner",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(f.dir, "companion"))).mode & 0o777).toBe(0o700);
    const handoff = LocalCompanionHandoffSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const response = await f.call("/v1/pairing/local/redeem", { offerSecret: handoff.offerSecret });
    expect(response.status).toBe(200);
    const session = LocalCompanionSessionSchema.parse(await response.json());
    expect(session.directRoute?.controlPlaneUrl).toBe(f.origin);
    expect(
      (await f.call("/v1/devices/self", undefined, { authorization: `Bearer ${session.deviceToken}` }))
        .status,
    ).toBe(200);
    expect((await f.call("/v1/pairing/local/redeem", { offerSecret: handoff.offerSecret })).status).toBe(409);
    await f.restart();
    const replacement = await f.mint();
    const restored = LocalCompanionSessionSchema.parse(
      await (await f.call("/v1/pairing/local/redeem", { offerSecret: replacement.offerSecret })).json(),
    );
    // Redeem schema accepts only the secret, so never send a returned offer verbatim.
    expect(restored.deviceId).toBe(session.deviceId);
    const listed = await (await f.call("/v1/devices", undefined, { authorization: "Bearer owner" })).json();
    expect(listed).toHaveLength(1);
    await f.call(`/v1/devices/${session.deviceId}/revoke`, {}, { authorization: "Bearer owner" });
    expect(
      (await f.call("/v1/devices/self", undefined, { authorization: `Bearer ${session.deviceToken}` }))
        .status,
    ).toBe(401);
    const fresh = await f.mint();
    const next = LocalCompanionSessionSchema.parse(
      await (await f.call("/v1/pairing/local/redeem", { offerSecret: fresh.offerSecret })).json(),
    );
    expect(next.deviceId).not.toBe(session.deviceId);
    expect(
      (await f.call("/v1/devices/self", undefined, { authorization: `Bearer ${session.deviceToken}` }))
        .status,
    ).toBe(401);
    const events = await readFile(join(f.dir, "events.jsonl"), "utf8");
    for (const secret of [handoff.offerSecret, session.deviceToken, fresh.offerSecret])
      expect(events).not.toContain(secret);
  });

  it("refuses anonymous minting, browsers, foreign Host, forwarded requests and both remote transports without consuming the offer", async () => {
    const f = await fixture();
    expect((await f.call("/v1/pairing/local/offer", {})).status).toBe(401);
    const offer = await f.mint();
    for (const headers of [
      { origin: "https://evil.example" },
      { origin: "null" },
      { "sec-fetch-site": "same-origin" },
      { "x-forwarded-for": "127.0.0.1" },
    ]) {
      expect(
        (await f.call("/v1/pairing/local/redeem", { offerSecret: offer.offerSecret }, headers)).status,
        JSON.stringify(headers),
      ).toBe(403);
    }
    const foreignHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        f.origin + "/v1/pairing/local/redeem",
        { method: "POST", headers: { host: "evil.example", "content-type": "application/json" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ offerSecret: offer.offerSecret }));
    });
    expect(foreignHost).toBe(403);
    const raw = new Request(f.origin + "/v1/pairing/local/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ offerSecret: offer.offerSecret }),
    });
    expect((await f.app().app.fetch(raw.clone())).status).toBe(403);
    expect((await deviceDoorwayFetch(f.app().app.fetch)(raw.clone())).status).toBe(404);
    expect(
      (
        await f.call("/v1/pairing/redeem", {
          offerSecret: offer.offerSecret,
          device: { name: "Foreign", platform: "ios" },
        })
      ).status,
    ).toBe(410);
    expect((await f.call("/v1/pairing/local/redeem", { offerSecret: offer.offerSecret })).status).toBe(200);
  });

  it("handles chunked native requests and atomically consumes concurrent redemptions", async () => {
    const f = await fixture();
    const offer = await f.mint();
    const chunked = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        f.origin + "/v1/pairing/local/redeem",
        { method: "POST", headers: { "content-type": "application/json" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.write(JSON.stringify({ offerSecret: offer.offerSecret }));
      req.end();
    });
    expect(chunked).toBe(200);
    const second = await f.mint();
    const statuses = await Promise.all(
      [1, 2].map(
        async () => (await f.call("/v1/pairing/local/redeem", { offerSecret: second.offerSecret })).status,
      ),
    );
    expect(statuses.sort()).toEqual([200, 409]);
    const superseded = await f.mint();
    await f.mint();
    expect((await f.call("/v1/pairing/local/redeem", { offerSecret: superseded.offerSecret })).status).toBe(
      410,
    );
  });

  it("refuses unsafe handoff directories and destination origins before any request", async () => {
    const f = await fixture();
    const linked = join(f.dir, "linked");
    await symlink(f.dir, linked);
    await expect(
      writeLocalCompanionHandoff({
        env: { CLANKIE_STATE: linked },
        controlPlaneUrl: f.origin,
        operatorToken: "owner",
      }),
    ).rejects.toThrow();
    const insecure = join(f.dir, "insecure");
    await mkdir(insecure, { mode: 0o777 });
    await chmod(insecure, 0o777);
    await expect(
      writeLocalCompanionHandoff({
        env: { CLANKIE_STATE: insecure },
        controlPlaneUrl: f.origin,
        operatorToken: "owner",
      }),
    ).rejects.toThrow();
    await expect(
      writeLocalCompanionHandoff({
        env: { CLANKIE_STATE: f.dir },
        controlPlaneUrl: "https://evil.example",
        operatorToken: "owner",
      }),
    ).rejects.toThrow();
  });
});
