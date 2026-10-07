import { PairingOfferWireSchema, directOriginTransport } from "@clankie/protocol";
import type { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClankieApp, type TrustedOperatorIdentity } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { deviceDoorwayFetch } from "../src/device-doorway.ts";
import { LocalCompanionBoundary } from "../src/local-companion-boundary.ts";
import type { HttpBindings } from "@hono/node-server";

// ADR 0204: a pairing link carries every route the Mac has, and a phone on the
// LAN reaches only the device routes through the opt-in device doorway.

const DEVICE_KEY = Uint8Array.from(Buffer.alloc(32, 7));
const DIRECT = { controlPlaneUrl: "http://192.168.4.20:4311", relayUrl: "http://192.168.4.20:4321" };
const IOS = { name: "James iPhone", platform: "ios" } as const;

afterEach(() => vi.unstubAllEnvs());

function operator(request: Request): Promise<TrustedOperatorIdentity | undefined> {
  return Promise.resolve(
    request.headers.get("authorization") === "Bearer operator-secret"
      ? { operatorId: "operator-james" }
      : undefined,
  );
}

async function makeApp(options: Omit<Parameters<typeof createClankieApp>[0], "captain"> = {}): Promise<Hono> {
  return (
    await createClankieApp({
      captain: createStubCaptain(),
      authenticateOperator: operator,
      deviceSessionKey: DEVICE_KEY,
      ...options,
    })
  ).app;
}

function configureDirectRoute(): void {
  vi.stubEnv("CLANKIE_DIRECT_CONTROL_PLANE_URL", DIRECT.controlPlaneUrl);
  vi.stubEnv("CLANKIE_RELAY_URL", DIRECT.relayUrl);
}

async function mint(app: Hono, body: unknown = {}) {
  const response = await app.request("/v1/pairing/offer", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer operator-secret" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

const post = (fetch: (request: Request) => Response | Promise<Response>, path: string, body: unknown) =>
  fetch(
    new Request(`http://192.168.4.20:4311${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("direct pairing links", () => {
  it("adds the configured direct control origin to an ordinary offer", async () => {
    configureDirectRoute();
    const minted = await mint(await makeApp());
    expect(minted.status).toBe(200);
    const wire = PairingOfferWireSchema.parse(minted.body);
    expect(wire.direct).toBe(DIRECT.controlPlaneUrl);
    expect(wire.gateway).toBeUndefined();
    const link = new URL(wire.deepLink);
    expect(link.searchParams.get("direct")).toBe(DIRECT.controlPlaneUrl);
    expect(link.searchParams.get("offer")).toMatch(/^[A-Za-z0-9_-]{20,}$/u);
  });

  it("carries both routes when remote access is on, keeping the gateway fragment last", async () => {
    configureDirectRoute();
    const app = await makeApp({
      pairingOfferPublisher: {
        publishPairingOffer: () => Promise.resolve(),
        protectPairingOffer: (offer) => {
          const deepLink = `clankie://connect?v=1&offer=${offer.offerSecret}#hostId=host-1&ticket=t`;
          return { version: 1, deepLink, code: deepLink, expiresAt: offer.expiresAt, gateway: true };
        },
      },
    });
    const wire = PairingOfferWireSchema.parse((await mint(app)).body);
    expect(wire.gateway).toBe(true);
    expect(wire.deepLink).toMatch(/&direct=http%3A%2F%2F192\.168\.4\.20%3A4311#hostId=host-1&ticket=t$/u);
    expect(wire.code).toBe(wire.deepLink);
  });

  it("still pairs directly when the doorway cannot carry the offer", async () => {
    configureDirectRoute();
    const signedOut = await makeApp({
      publicGatewayDoorway: () => ({ state: "sign_in_required", since: "2026-09-30T08:00:00.000Z" }),
    });
    const fromSignedOut = PairingOfferWireSchema.parse((await mint(signedOut)).body);
    expect(fromSignedOut.direct).toBe(DIRECT.controlPlaneUrl);
    expect(fromSignedOut.deepLink).not.toContain("#");

    const offline = await makeApp({
      pairingOfferPublisher: {
        publishPairingOffer: () => Promise.reject(new Error("offline")),
        protectPairingOffer: () => {
          throw new Error("must not protect an unpublished offer");
        },
      },
    });
    const fromOffline = PairingOfferWireSchema.parse((await mint(offline)).body);
    expect(fromOffline.gateway).toBeUndefined();
    expect(fromOffline.direct).toBe(DIRECT.controlPlaneUrl);
  });

  it("keeps private addresses out of review offers, which only the gateway can carry", async () => {
    configureDirectRoute();
    const app = await makeApp({
      publicGatewayDoorway: () => ({ state: "unavailable" }),
    });
    const refused = await mint(app, { review: { days: 3 } });
    expect(refused.status).toBe(503);

    const local = await makeApp({ publicGatewayDoorway: () => ({ state: "disabled" }) });
    const wire = PairingOfferWireSchema.parse((await mint(local, { review: { days: 3 } })).body);
    expect(wire.direct).toBeUndefined();
    expect(wire.deepLink).not.toContain("direct=");
    expect(wire.localCode).toBeUndefined();
  });

  it("gives the operator the short same-Mac code beside a gateway-protected link", async () => {
    const app = await makeApp({
      pairingOfferPublisher: {
        publishPairingOffer: () => Promise.resolve(),
        protectPairingOffer: (offer) => {
          const deepLink = `clankie://connect?v=1&offer=${offer.offerSecret}#hostId=host-1&ticket=t`;
          return { version: 1, deepLink, code: deepLink, expiresAt: offer.expiresAt, gateway: true };
        },
      },
    });
    const wire = PairingOfferWireSchema.parse((await mint(app)).body);
    expect(wire.code).toBe(wire.deepLink);
    expect(wire.localCode).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/u);

    const anonymous = await app.request("/v1/pairing/offer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(anonymous.status).toBe(401);
    expect(JSON.stringify(await anonymous.json())).not.toContain("localCode");
  });
});

describe("device doorway", () => {
  it("pairs a device end to end through the doorway and learns the direct route", async () => {
    configureDirectRoute();
    const app = await makeApp();
    const doorway = deviceDoorwayFetch(app.fetch);
    const wire = PairingOfferWireSchema.parse((await mint(app)).body);
    const offerSecret = new URL(wire.deepLink).searchParams.get("offer");

    const redeemed = await post(doorway, "/v1/pairing/redeem", { offerSecret, device: IOS });
    expect(redeemed.status).toBe(200);
    const { completionToken, offeredGrants } = (await redeemed.json()) as {
      completionToken: string;
      offeredGrants: unknown;
    };
    const completed = await post(doorway, "/v1/pairing/complete", {
      completionToken,
      acceptedGrants: offeredGrants,
    });
    expect(completed.status).toBe(200);
    const session = (await completed.json()) as { deviceToken: string; directRoute: unknown };
    expect(session.directRoute).toEqual(DIRECT);

    const self = await doorway(
      new Request("http://192.168.4.20:4311/v1/devices/self", {
        headers: { authorization: `Bearer ${session.deviceToken}` },
      }),
    );
    expect(self.status).toBe(200);

    // The offer stays single use through either door.
    expect((await post(doorway, "/v1/pairing/redeem", { offerSecret, device: IOS })).status).toBe(409);
  });

  it("answers 404 for every route a LAN peer must not reach", async () => {
    const app = await makeApp();
    const doorway = deviceDoorwayFetch(app.fetch);
    for (const [method, path] of [
      ["POST", "/v1/pairing/offer"],
      ["GET", "/health"],
      ["POST", "/v1/gateway/encrypted"],
      ["POST", "/v1/hosted/operator"],
      ["POST", "/v1/hooks/linear"],
      ["GET", "/v1/devices/x/unrelated"],
    ] as const) {
      const response = await doorway(new Request(`http://192.168.4.20:4311${path}`, { method }));
      expect({ method, path, status: response.status }).toEqual({ method, path, status: 404 });
    }
  });
});

describe("same-Mac pairing", () => {
  // A Mac app pairs with its own service over loopback. The configured direct
  // route is for other devices and is often plain HTTP that macOS refuses.
  const LOOPBACK = { controlPlaneUrl: "http://127.0.0.1:4310", relayUrl: "http://127.0.0.1:4321" };
  const MAC = { name: "Clankie Mac", platform: "macos" } as const;
  const env = {
    incoming: { socket: { remoteAddress: "127.0.0.1", localAddress: "127.0.0.1" } },
  } as unknown as HttpBindings;

  async function sameMacService() {
    configureDirectRoute();
    const boundary = new LocalCompanionBoundary();
    const app = await makeApp({ isSameMacRequest: (request) => boundary.isSameMac(request) });
    const listener = boundary.fetch(app.fetch);
    // Node's server hands the app the Host header a real client sent.
    const send = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("host", new URL(LOOPBACK.controlPlaneUrl).host);
      return listener(new Request(`${LOOPBACK.controlPlaneUrl}${path}`, { ...init, headers }), env);
    };
    const pair = async (headers: Record<string, string> = {}) => {
      const wire = PairingOfferWireSchema.parse((await mint(app)).body);
      const offerSecret = new URL(wire.deepLink).searchParams.get("offer");
      const json = { "content-type": "application/json", ...headers };
      const redeemed = (await (
        await send("/v1/pairing/redeem", {
          method: "POST",
          headers: json,
          body: JSON.stringify({ offerSecret, device: MAC }),
        })
      ).json()) as { completionToken: string; offeredGrants: unknown };
      const completed = await send("/v1/pairing/complete", {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          completionToken: redeemed.completionToken,
          acceptedGrants: redeemed.offeredGrants,
        }),
      });
      expect(completed.status).toBe(200);
      return (await completed.json()) as { deviceToken: string; relayUrl?: string; directRoute?: unknown };
    };
    return { send, pair };
  }

  it("gives a native client on this Mac its own loopback service and relay", async () => {
    const { send, pair } = await sameMacService();
    const session = await pair();
    expect(session).toMatchObject({ relayUrl: LOOPBACK.relayUrl, directRoute: LOOPBACK });

    const auth = { authorization: `Bearer ${session.deviceToken}` };
    const self = (await (await send("/v1/devices/self", { headers: auth })).json()) as {
      directRoute?: unknown;
    };
    expect(self.directRoute).toEqual(LOOPBACK);
    const refreshed = (await (
      await send("/v1/devices/self/session/refresh", { method: "POST", headers: auth })
    ).json()) as { relayUrl?: string; directRoute?: unknown };
    expect(refreshed.relayUrl).toBe(LOOPBACK.relayUrl);
  });

  it("keeps the advertised route for requests the gateway forwards over loopback", async () => {
    const { pair } = await sameMacService();
    const session = await pair({ "x-clankie-gateway": "1" });
    expect(session.directRoute).toEqual(DIRECT);
  });
});

describe("directOriginTransport", () => {
  it.each([
    ["https://mac.tail1234.ts.net", "https"],
    ["https://mac.tail1234.ts.net:4311", "https"],
    ["http://192.168.4.20:4311", "local"],
    ["http://10.0.0.5:4311", "local"],
    ["http://172.20.1.1:4311", "local"],
    ["http://169.254.3.3:4311", "local"],
    ["http://[fe80::1]:4311", "local"],
    ["http://[fd12::1]:4311", "local"],
    ["http://james-mac.local:4311", "local"],
    ["http://james-mac:4311", "local"],
    ["http://mac.tail1234.ts.net:4311", "blocked"],
    ["http://100.103.220.58:4311", "blocked"],
    ["http://8.8.8.8:4311", "blocked"],
    ["http://172.32.0.1:4311", "blocked"],
    ["ftp://192.168.4.20", "blocked"],
    ["not a url", "blocked"],
  ])("%s → %s", (origin, expected) => {
    expect(directOriginTransport(origin)).toBe(expected);
  });
});
