import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DomainEvent } from "@clankie/protocol";
import type { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createClankieApp, type TrustedOperatorIdentity } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeApp(options: Omit<Parameters<typeof createClankieApp>[0], "captain"> = {}): Promise<Hono> {
  return (await createClankieApp({ captain: createStubCaptain(), ...options })).app;
}

function operator(request: Request): Promise<TrustedOperatorIdentity | undefined> {
  return Promise.resolve(
    request.headers.get("authorization") === "Bearer operator-secret"
      ? { operatorId: "operator-james" }
      : undefined,
  );
}

/**
 * Mirror of the provisional client contract in `apps/tui/bin/pairing-offer.ts`
 * (`PairingOfferSchema`). Kept as a literal copy so a server drift from what
 * `clankie pair` validates fails here; VUH-727 owns the canonical schema.
 */
const ClientPairingOfferSchema = z.object({
  version: z.number().int().positive(),
  deepLink: z.string().min(1),
  code: z.string().min(1),
  expiresAt: z.iso.datetime(),
});

const mintOffer = (app: Hono, token?: string, body: unknown = {}) =>
  app.request("/v1/pairing/offer", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });

const redeem = (app: Hono, body: unknown) =>
  app.request("/v1/pairing/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const DEVICE_KEY = Uint8Array.from(Buffer.alloc(32, 7));
const IOS = { name: "Reviewer iPhone", platform: "ios" } as const;

async function tempEventLog(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clankie-pairing-"));
  tempDirs.push(root);
  return join(root, "events.jsonl");
}

function readEvents(path: string): DomainEvent[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DomainEvent);
}

describe("control-plane pairing offer surface", () => {
  it("fails closed when no authenticated operator surface is configured", async () => {
    const app = await makeApp();
    const response = await mintOffer(app, "operator-secret");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "operator_authentication_unavailable" });
  });

  it("requires the operator bearer and rejects a wrong credential", async () => {
    const app = await makeApp({ authenticateOperator: operator });
    expect((await mintOffer(app)).status).toBe(401);
    expect((await mintOffer(app, "wrong-secret")).status).toBe(401);
  });

  it("mints an offer matching the `clankie pair` contract, unique per request", async () => {
    const now = new Date("2026-07-13T12:00:00.000Z");
    const app = await makeApp({ authenticateOperator: operator, clock: () => now });
    const first = await mintOffer(app, "operator-secret");
    expect(first.status).toBe(200);
    const offer = ClientPairingOfferSchema.parse(await first.json());
    expect(offer.version).toBe(1);
    expect(offer.deepLink).toMatch(/^clankie:\/\/connect\?v=1&offer=[A-Za-z0-9_-]{20,}$/);
    // Typed-pairing code: two groups from the unambiguous alphabet (no 0/O/1/I/L).
    expect(offer.code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    expect(Date.parse(offer.expiresAt)).toBe(now.getTime() + 5 * 60_000);

    const second = ClientPairingOfferSchema.parse(await (await mintOffer(app, "operator-secret")).json());
    expect(second.code).not.toBe(offer.code);
    expect(second.deepLink).not.toBe(offer.deepLink);
  });

  it("publishes a public-gateway offer before exposing it and fails closed when publication fails", async () => {
    const published: Array<{ readonly offerSecret: string; readonly code: string }> = [];
    const app = await makeApp({
      authenticateOperator: operator,
      pairingOfferPublisher: {
        publishPairingOffer: (offer) => {
          published.push({ offerSecret: offer.offerSecret, code: offer.code });
          return Promise.resolve();
        },
      },
    });
    const response = await mintOffer(app, "operator-secret");
    expect(response.status).toBe(200);
    const wire = ClientPairingOfferSchema.parse(await response.json());
    expect(published).toHaveLength(1);
    expect(new URL(wire.deepLink).searchParams.get("offer")).toBe(published[0]?.offerSecret);
    expect(wire.code).toBe(published[0]?.code);

    const unavailable = await makeApp({
      authenticateOperator: operator,
      pairingOfferPublisher: {
        publishPairingOffer: () => Promise.reject(new Error("offline")),
      },
    });
    const denied = await mintOffer(unavailable, "operator-secret");
    expect(denied.status).toBe(503);
    await expect(denied.json()).resolves.toEqual({ error: "public_gateway_unavailable" });
  });

  it("records a secret-free audit event for each minted offer", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-pairing-"));
    tempDirs.push(root);
    const eventLogPath = join(root, "events.jsonl");
    const app = await makeApp({
      eventLogPath,
      authenticateOperator: operator,
      idFactory: () => "deadbeefdeadbeefdeadbeef",
    });
    const response = await mintOffer(app, "operator-secret");
    expect(response.status).toBe(200);
    const offer = ClientPairingOfferSchema.parse(await response.json());

    const minted = readFileSync(eventLogPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as DomainEvent)
      .filter((event) => event.type === "pairing.offer.minted");
    expect(minted).toHaveLength(1);
    expect(minted[0]).toMatchObject({
      missionId: "pairing:pairing-offer-deadbeefdead",
      data: {
        offerId: "pairing-offer-deadbeefdead",
        operatorId: "operator-james",
        expiresAt: offer.expiresAt,
      },
    });
    const serialized = JSON.stringify(minted[0]);
    expect(serialized).not.toContain(offer.code);
    const offerSecret = new URL(offer.deepLink).searchParams.get("offer");
    expect(offerSecret).toBeTruthy();
    expect(serialized).not.toContain(offerSecret as string);
  });
});

describe("review pairing offers (ADR 0154)", () => {
  it("mints a days-long review offer only within the gateway's route window", async () => {
    const now = new Date("2026-09-02T12:00:00.000Z");
    const app = await makeApp({ authenticateOperator: operator, clock: () => now });
    const response = await mintOffer(app, "operator-secret", { review: { days: 14 } });
    expect(response.status).toBe(200);
    const wire = (await response.json()) as { expiresAt: string; review?: true };
    expect(Date.parse(wire.expiresAt)).toBe(now.getTime() + 14 * 24 * 60 * 60_000);
    expect(wire.review).toBe(true);
    expect((await mintOffer(app, "operator-secret", { review: { days: 32 } })).status).toBe(400);
    expect((await mintOffer(app, "operator-secret", { review: { days: 0 } })).status).toBe(400);
    expect((await mintOffer(app, "operator-secret", { review: "yes" })).status).toBe(400);
    // An ordinary offer is unchanged: five minutes, no review marker.
    const ordinary = (await (await mintOffer(app, "operator-secret")).json()) as {
      expiresAt: string;
      review?: true;
    };
    expect(Date.parse(ordinary.expiresAt)).toBe(now.getTime() + 5 * 60_000);
    expect(ordinary.review).toBeUndefined();
  });

  it("records the gateway hashes for a review offer and nothing secret-bearing beyond them", async () => {
    const eventLogPath = await tempEventLog();
    const app = await makeApp({ eventLogPath, authenticateOperator: operator });
    const wire = (await (await mintOffer(app, "operator-secret", { review: { days: 7 } })).json()) as {
      deepLink: string;
      code: string;
    };
    const offerSecret = new URL(wire.deepLink).searchParams.get("offer") as string;
    const minted = readEvents(eventLogPath).filter((event) => event.type === "pairing.offer.minted");
    expect(minted).toHaveLength(1);
    expect(minted[0]?.data).toMatchObject({
      review: true,
      offerHash: sha256(offerSecret),
      codeHash: sha256(wire.code.replace("-", "")),
    });
    const serialized = JSON.stringify(minted[0]);
    expect(serialized).not.toContain(wire.code);
    expect(serialized).not.toContain(offerSecret);
  });

  it("restores an unredeemed review offer across a restart and hands the gateway its route", async () => {
    const eventLogPath = await tempEventLog();
    const first = await makeApp({
      eventLogPath,
      authenticateOperator: operator,
      deviceSessionKey: DEVICE_KEY,
    });
    const wire = (await (await mintOffer(first, "operator-secret", { review: { days: 7 } })).json()) as {
      deepLink: string;
      code: string;
    };
    const offerSecret = new URL(wire.deepLink).searchParams.get("offer") as string;

    const restored: Array<{ readonly offerHash: string; readonly codeHash: string }> = [];
    const second = await makeApp({
      eventLogPath,
      authenticateOperator: operator,
      deviceSessionKey: DEVICE_KEY,
      pairingOfferPublisher: {
        publishPairingOffer: () => Promise.resolve(),
        restorePairingRoute: (route) => {
          restored.push({ offerHash: route.offerHash, codeHash: route.codeHash });
        },
      },
    });
    expect(restored).toEqual([
      { offerHash: sha256(offerSecret), codeHash: sha256(wire.code.replace("-", "")) },
    ]);
    const redeemed = await redeem(second, { code: wire.code.toLowerCase(), device: IOS });
    expect(redeemed.status).toBe(200);
    // Single use survives too: the same code is consumed on the restarted service.
    expect((await redeem(second, { offerSecret, device: IOS })).status).toBe(409);
    const devices = (await (
      await second.request("/v1/devices", { headers: { authorization: "Bearer operator-secret" } })
    ).json()) as Array<{ review?: true }>;
    expect(devices).toHaveLength(1);
    expect(devices[0]?.review).toBe(true);
  });

  it("does not restore a review offer that was redeemed, expired, or ordinary", async () => {
    const eventLogPath = await tempEventLog();
    let nowMs = Date.parse("2026-09-02T12:00:00.000Z");
    const clock = () => new Date(nowMs);
    const first = await makeApp({
      eventLogPath,
      authenticateOperator: operator,
      deviceSessionKey: DEVICE_KEY,
      clock,
    });
    const redeemedWire = (await (
      await mintOffer(first, "operator-secret", { review: { days: 3 } })
    ).json()) as {
      code: string;
    };
    expect((await redeem(first, { code: redeemedWire.code, device: IOS })).status).toBe(200);
    const expiredWire = (await (
      await mintOffer(first, "operator-secret", { review: { days: 1 } })
    ).json()) as {
      code: string;
    };
    const ordinaryWire = (await (await mintOffer(first, "operator-secret")).json()) as { code: string };

    nowMs += 2 * 24 * 60 * 60_000;
    const restored: string[] = [];
    const second = await makeApp({
      eventLogPath,
      authenticateOperator: operator,
      deviceSessionKey: DEVICE_KEY,
      clock,
      pairingOfferPublisher: {
        publishPairingOffer: () => Promise.resolve(),
        restorePairingRoute: (route) => {
          restored.push(route.offerId);
        },
      },
    });
    expect(restored).toEqual([]);
    for (const code of [redeemedWire.code, expiredWire.code, ordinaryWire.code]) {
      expect((await redeem(second, { code, device: IOS })).status).toBe(410);
    }
  });
});
