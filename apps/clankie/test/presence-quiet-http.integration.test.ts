import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
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
import { projectPresence } from "../src/captain/presence.ts";

// The real service route, pairing and revocation, with the real quiet-hours
// reading and projection behind the captain's dispatch.
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

async function fixture(held?: Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "presence-quiet-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
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
    eventLogPath: join(root, "events.jsonl"),
    deviceSessionKey: randomBytes(32),
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
  return { asked, call, read, pair, parked };
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
