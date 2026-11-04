import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { SUPERVISE_GRANTS, TAKE_CONTROL_GRANTS } from "@clankie/protocol";
import { OperatorPresenceResultSchema } from "@clankie/protocol/presence";
import { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain, type CaptainPort } from "../src/captain/port.ts";
import { DesktopExpressions } from "../src/captain/desktop.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { projectPresence } from "../src/captain/presence.ts";

// The real service route, pairing and revocation, with the real quiet-hours
// reading and projection behind the captain's dispatch.
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

/** Take Control devices the owner's pairing can't produce, written as their event history. */
const NOT_THE_OWNERS = {
  connector: { mintedBy: "local-operator", scope: "connector" },
  visitor: { mintedBy: "hosted-account" },
  support: { mintedBy: "local-operator", supportGrantId: randomUUID() },
};

function deviceEvents(now: number) {
  const iso = (offset: number) => new Date(now + offset).toISOString();
  return Object.entries(NOT_THE_OWNERS).flatMap(([deviceId, device]) => {
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

async function fixture(held?: Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "presence-quiet-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const deviceSessionKey = randomBytes(32);
  const eventLogPath = join(root, "events.jsonl");
  await writeFile(
    eventLogPath,
    deviceEvents(now)
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
  const app = await createClankieApp({
    settings: new SettingsStore(join(root, "settings.json")),
    captain: createStubCaptain({ serveOperatorConversation }),
    eventLogPath,
    deviceSessionKey,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer relay"
        ? { captainId: "relay", steerSourceLane: "api" }
        : undefined,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  const server = serve({ fetch: app.app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanup.push(async () => {
    await app.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const call = (path: string, body: unknown, bearer = "owner") =>
    fetch(origin + path, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const read = (bearer: string) =>
    call("/operator/v1/dispatch", { op: "presence", schemaVersion: 1, includeQuiet: true }, bearer);
  const pair = async (grants: typeof TAKE_CONTROL_GRANTS | typeof SUPERVISE_GRANTS) => {
    const offer = await (await call("/v1/pairing/offer", {})).json();
    const pending = await (
      await call("/v1/pairing/redeem", {
        offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
        device: { name: "Phone", platform: "ios" },
      })
    ).json();
    return (await (
      await call("/v1/pairing/complete", { completionToken: pending.completionToken, acceptedGrants: grants })
    ).json()) as { deviceId: string; deviceToken: string };
  };
  return { asked, call, read, pair, parked, tokenFor };
}

const snapshotOf = async (response: Response) => {
  expect(response.status).toBe(200);
  return OperatorPresenceResultSchema.parse(await response.json()).snapshot;
};
const quiet = { quiet: true, quietUntil: "2026-11-04T23:59:00.000Z" };

it("answers quiet hours for the operator and a Take Control device, and for nobody else", async () => {
  const f = await fixture();
  expect(await snapshotOf(await f.read("owner"))).toMatchObject(quiet);
  const { deviceToken } = await f.pair(TAKE_CONTROL_GRANTS);
  expect(await snapshotOf(await f.read(deviceToken))).toMatchObject(quiet);

  // The relay's own bearer, which is how every other device's presence read arrives.
  const relayed = await snapshotOf(await f.read("relay"));
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
