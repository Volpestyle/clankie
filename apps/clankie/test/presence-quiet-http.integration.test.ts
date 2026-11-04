import { LocalCompanionBoundary } from "../src/local-companion-boundary.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { DeviceSelfResponseSchema, SUPERVISE_GRANTS, TAKE_CONTROL_GRANTS } from "@clankie/protocol";
import { OperatorPresenceResultSchema } from "@clankie/protocol/presence";
import { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain, type CaptainPort } from "../src/captain/port.ts";
import { DesktopExpressions } from "../src/captain/desktop.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { projectPresence } from "../src/captain/presence.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import {
  createCaptainConversationDispatch,
  createDeviceConversationDispatch,
} from "../../relay/src/conversation-upstream.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";

// The real service route, pairing and revocation, with the real quiet-hours
// reading and projection behind the captain's dispatch.
const cleanup: (() => Promise<unknown> | void)[] = [];
const RELAY_BEARER = "quiet-presence-relay-fixture-token";
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Take Control devices the owner's pairing can't produce, written as their event history. */
const NOT_THE_OWNERS = {
  connector: { mintedBy: "local-operator", scope: "connector" },
  visitor: { mintedBy: "hosted-account" },
  support: { mintedBy: "local-operator", supportGrantId: randomUUID() },
};

function deviceEvents(now: number, extra: Record<string, { mintedBy: string }> = {}) {
  const iso = (offset: number) => new Date(now + offset).toISOString();
  return Object.entries({ ...NOT_THE_OWNERS, ...extra }).flatMap(([deviceId, device]) => {
    const event = (type: string, data: object) => ({
      id: randomUUID(),
      type,
      occurredAt: iso(-60_000),
      missionId: `device:${deviceId}`,
      correlationId: "presence-quiet",
      profileHash: "fixture",
      data: { schemaVersion: 1, deviceId, ...data },
    });
    return [
      event("device.pairing.redeemed", {
        offerId: deviceId,
        name: deviceId,
        platform: "ios",
        offeredGrants: TAKE_CONTROL_GRANTS,
        pendingExpiresAt: iso(60_000),
        ...device,
      }),
      event("device.activated", { grants: TAKE_CONTROL_GRANTS, sessionExpiresAt: iso(3_600_000) }),
    ];
  });
}

async function fixture(held?: Promise<void>, extra: Record<string, { mintedBy: string }> = {}) {
  const root = await mkdtemp(join(tmpdir(), "presence-quiet-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const deviceSessionKey = randomBytes(32);
  const eventLogPath = join(root, "events.jsonl");
  await writeFile(
    eventLogPath,
    deviceEvents(now, extra)
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const signer = new DeviceSessionSigner(deviceSessionKey);
  const tokenFor = (deviceId: string) =>
    signer.issue(
      mintDeviceSessionClaims({ deviceId, nowEpochSeconds: Math.floor(now / 1000), ttlSeconds: 3600 }),
    );
  // Quiet all day from anywhere: the whole clock but its last minute.
  const desktop = new DesktopExpressions(
    async () => ({
      quietHours: { start: "00:00", end: "23:59", timeZone: "UTC" },
    }),
    () => Date.parse("2026-11-04T12:00:00.000Z"),
  );
  const asked: boolean[] = [];
  let reached = () => {};
  const parked = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const serveOperatorConversation = (async (request: { op: string; includeQuiet?: boolean }) => {
    if (request.op !== "presence") throw new Error(`Unexpected ${request.op}`);
    asked.push(request.includeQuiet === true);
    reached();
    await held;
    const snapshot = projectPresence({
      thinking: false,
      working: false,
      inVoice: false,
      playing: false,
      activeSeats: 0,
      ...(request.includeQuiet ? { quietHours: await desktop.quietHours() } : {}),
    } as Parameters<typeof projectPresence>[0]);
    return { op: "presence", schemaVersion: 1, snapshot };
  }) as unknown as CaptainPort["serveOperatorConversation"];
  const boundary = new LocalCompanionBoundary();
  const app = await createClankieApp({
    isSameMacRequest: (request) => boundary.isSameMac(request),
    settings: new SettingsStore(join(root, "settings.json")),
    captain: createStubCaptain({ serveOperatorConversation }),
    eventLogPath,
    deviceSessionKey,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === `Bearer ${RELAY_BEARER}`
        ? { captainId: "relay", steerSourceLane: "api" }
        : undefined,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  const server = serve({ fetch: boundary.fetch(app.app.fetch), hostname: "127.0.0.1", port: 0 }) as Server;
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanup.push(async () => {
    await app.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const handler = createOperatorConversationRelayHandler({
    authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl: origin }),
    dispatch: createCaptainConversationDispatch({ baseUrl: origin, bearerToken: RELAY_BEARER }),
    deviceDispatch: createDeviceConversationDispatch({ baseUrl: origin }),
  });
  const relay = createServer((request, response) => {
    void handler(request, response).then((handled) => {
      if (!handled) response.writeHead(404).end();
    });
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  const relayOrigin = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  cleanup.push(async () => {
    relay.closeAllConnections();
    await new Promise((resolve) => relay.close(resolve));
  });
  const call = (path: string, body: unknown, bearer = "owner") =>
    fetch(origin + path, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const read = (bearer: string) =>
    call("/operator/v1/dispatch", { op: "presence", schemaVersion: 1, includeQuiet: true }, bearer);
  const pair = async (grants: typeof TAKE_CONTROL_GRANTS | typeof SUPERVISE_GRANTS, bearer = "owner") => {
    const offer = await (await call("/v1/pairing/offer", {}, bearer)).json();
    const pending = await (
      await call(
        "/v1/pairing/redeem",
        {
          offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
          device: { name: "Phone", platform: "ios" },
        },
        bearer,
      )
    ).json();
    return (await (
      await call(
        "/v1/pairing/complete",
        { completionToken: pending.completionToken, acceptedGrants: grants },
        bearer,
      )
    ).json()) as { deviceId: string; deviceToken: string };
  };
  const relayRead = (bearer: string) =>
    fetch(relayOrigin + "/operator/v1/dispatch", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "presence", schemaVersion: 1, includeQuiet: true }),
    });
  const self = async (bearer: string) => {
    const response = await fetch(origin + "/v1/devices/self", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(response.status).toBe(200);
    return DeviceSelfResponseSchema.parse(await response.json());
  };
  return { asked, call, read, pair, parked, tokenFor, relayRead, self };
}

const snapshotOf = async (response: Response) => {
  expect(response.status).toBe(200);
  return OperatorPresenceResultSchema.parse(await response.json()).snapshot;
};
const quiet = { quiet: true, quietUntil: "2026-11-04T23:59:00.000Z" };

it("shares the service's owner-device decision through the real relay without exposing quiet hours to a Take Control visitor", async () => {
  const f = await fixture();
  const owner = await f.pair(TAKE_CONTROL_GRANTS);
  expect(await snapshotOf(await f.relayRead(owner.deviceToken))).toMatchObject(quiet);

  // The visitor has Take Control and no relay-side support/controlScope marker.
  // Its actual registration is sufficient for the service to refuse owner-only data.
  const visitor = f.tokenFor("visitor");
  const ordinary = await snapshotOf(await f.relayRead(visitor));
  expect(ordinary).not.toHaveProperty("quiet");
  expect(ordinary).not.toHaveProperty("quietUntil");
  expect(f.asked).toEqual([true, false]);
  expect((await f.self(owner.deviceToken)).ownerDevice).toBe(true);
  expect((await f.self(visitor)).ownerDevice).toBe(false);
  expect((await f.read(visitor)).status).toBe(401);

  const supervise = await f.pair(SUPERVISE_GRANTS);
  expect((await f.self(supervise.deviceToken)).ownerDevice).toBe(true);
  const supervised = await snapshotOf(await f.relayRead(supervise.deviceToken));
  expect(supervised).not.toHaveProperty("quiet");
  expect(supervised).not.toHaveProperty("quietUntil");
  expect((await f.self(f.tokenFor("connector"))).ownerDevice).toBe(false);
  expect((await f.relayRead(f.tokenFor("connector"))).status).toBe(403);
  expect(f.asked).toEqual([true, false, false]);
});

it("answers quiet hours for the operator and a Take Control device, and for nobody else", async () => {
  const f = await fixture();
  expect(await snapshotOf(await f.read("owner"))).toMatchObject(quiet);
  const { deviceToken } = await f.pair(TAKE_CONTROL_GRANTS);
  expect(await snapshotOf(await f.read(deviceToken))).toMatchObject(quiet);

  // The relay's own bearer, which is how every other device's presence read arrives.
  const relayed = await snapshotOf(await f.read(RELAY_BEARER));
  expect(relayed).not.toHaveProperty("quiet");
  expect(relayed).not.toHaveProperty("quietUntil");
  expect(f.asked).toEqual([true, true, false]);
});

it("stops at the boundary for a Supervise device and an unknown bearer", async () => {
  const f = await fixture();
  const { deviceToken } = await f.pair(SUPERVISE_GRANTS);
  for (const bearer of [deviceToken, "nobody"]) {
    const response = await f.read(bearer);
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain("quiet");
  }
  expect(f.asked).toEqual([]);
});

it("holds other Take Control devices to the service's ordinary presence boundary", async () => {
  const f = await fixture();
  for (const deviceId of Object.keys(NOT_THE_OWNERS)) {
    const bearer = f.tokenFor(deviceId);
    for (const body of [
      { op: "presence", schemaVersion: 1 },
      { op: "presence", schemaVersion: 1, includeQuiet: true },
    ]) {
      const response = await f.call("/operator/v1/dispatch", body, bearer);
      expect(response.status, `${deviceId} ${JSON.stringify(body)}`).toBe(401);
      expect(JSON.stringify(await response.json())).not.toContain("quiet");
    }
  }
  expect(f.asked).toEqual([]);
});

it("takes the fields back from a read that outlasts its device's Take Control", async () => {
  let release = () => {};
  const f = await fixture(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const { deviceId, deviceToken } = await f.pair(TAKE_CONTROL_GRANTS);
  const pending = f.read(deviceToken);
  await f.parked;
  expect((await f.call(`/v1/devices/${deviceId}/revoke`, {})).ok).toBe(true);
  release();
  const snapshot = await snapshotOf(await pending);
  expect(snapshot).not.toHaveProperty("quiet");
  expect(snapshot).not.toHaveProperty("quietUntil");
});

it("keeps device offer minting within recorded owner provenance on native loopback HTTP", async () => {
  const f = await fixture();
  for (const id of ["visitor"]) {
    expect((await f.self(f.tokenFor(id))).ownerDevice).toBe(false);
    expect((await f.call("/v1/pairing/offer", {}, f.tokenFor(id))).status).toBe(403);
  }
  // Scoped connector sessions are refused before the ordinary device minter.
  expect((await f.call("/v1/pairing/offer", {}, f.tokenFor("connector"))).status).toBe(401);
  // Every device-minted offer below uses only the preceding signed device session.
  const original = await f.pair(TAKE_CONTROL_GRANTS);
  const child = await f.pair(TAKE_CONTROL_GRANTS, original.deviceToken);
  const grandchild = await f.pair(TAKE_CONTROL_GRANTS, child.deviceToken);
  for (const paired of [original, child, grandchild]) {
    expect((await f.self(paired.deviceToken)).ownerDevice).toBe(true);
    expect(await snapshotOf(await f.relayRead(paired.deviceToken))).toMatchObject(quiet);
  }
});

it("keeps ordinary presence for persisted device lineages without complete owner provenance", async () => {
  const f = await fixture(undefined, {
    child: { mintedBy: "device:visitor" },
    grandchild: { mintedBy: "device:child" },
    supportChild: { mintedBy: "device:support" },
    connectorChild: { mintedBy: "device:connector" },
    missingParent: { mintedBy: "device:absent" },
    cycleA: { mintedBy: "device:cycleB" },
    cycleB: { mintedBy: "device:cycleA" },
  });
  for (const id of [
    "child",
    "grandchild",
    "supportChild",
    "connectorChild",
    "missingParent",
    "cycleA",
    "cycleB",
  ]) {
    const token = f.tokenFor(id);
    expect((await f.self(token)).ownerDevice).toBe(false);
    expect((await f.call("/v1/pairing/offer", {}, token)).status).toBe(403);
    const snapshot = await snapshotOf(await f.relayRead(token));
    expect(snapshot).not.toHaveProperty("quiet");
    expect(snapshot).not.toHaveProperty("quietUntil");
  }
});

it("derives a revoked direct read's cursor from exactly its sanitized HTTP response", async () => {
  let release = () => {};
  const f = await fixture(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const owner = await f.pair(TAKE_CONTROL_GRANTS);
  const pending = f.read(owner.deviceToken);
  await f.parked;
  expect((await f.call(`/v1/devices/${owner.deviceId}/revoke`, {})).status).toBe(200);
  release();
  const snapshot = await snapshotOf(await pending);
  expect(snapshot).not.toHaveProperty("quiet");
  expect(snapshot).not.toHaveProperty("quietUntil");
  const { cursor, ...projection } = snapshot;
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  expect(cursor).toBe(digest(projection));
  expect(cursor).not.toBe(digest({ ...projection, ...quiet }));
});
