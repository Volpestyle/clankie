import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SUPERVISE_GRANTS, TAKE_CONTROL_GRANTS, type DeviceGrantSet } from "@clankie/protocol";
import { FLEET_BODY_CREDITS_PATH, HOSTED_CREDITS_PATH } from "@clankie/protocol/hosted-credits";
import { publicGatewayTargetFor } from "@clankie/protocol/public-gateway";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { HostedBodyClient } from "../src/hosted-body.ts";
import { hostedFixture } from "./fixtures/hosted-body.ts";

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** The fleet's answer: a Pro pack with 30 credits, 21.5 spent, plus 9 rolled-over top-up credits. */
const BALANCE = {
  pack: { credits: 30, used: 21.5, resetsAt: "2026-10-12T00:00:00.000Z" },
  topUp: 9,
  available: 17.5,
  low: false,
  buyUrl: "https://clankie.bot/account#credits",
};

/**
 * A body whose credits come from a real signed `HostedBodyClient` talking to a
 * fake fleet, or no hosted client at all (`hosted: false`, a self-hosted body).
 */
async function setup(options: { hosted?: boolean; fleet?: typeof fetch } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "hosted-credits-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const f = hostedFixture();
  const fleet = vi.fn<typeof fetch>(options.fleet ?? (async () => Response.json(BALANCE)));
  const client = new HostedBodyClient(f.bootstrap, {
    clock: () => f.now,
    fetch: async (url, init) =>
      new URL(String(url)).pathname === "/fleet/v1/body/pairing-key" ? Response.json({}) : fleet(url, init),
  });
  await client.registerPairingKey(generateKeyPairSync("ed25519").privateKey);
  const app = await createClankieApp({
    captain: createStubCaptain(),
    deviceSessionKey: randomBytes(32),
    eventLogPath: join(dir, "events.jsonl"),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    ...(options.hosted === false ? {} : { hostedCredits: client }),
  });
  cleanups.push(() => app.close());
  const request = async (path: string, token: string | undefined, body?: unknown) => {
    const response = await app.app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: (await response.json()) as unknown,
    };
  };
  const pair = async (acceptedGrants: DeviceGrantSet) => {
    const offer = (await request("/v1/pairing/offer", "owner", {})).body as {
      deepLink: string;
    };
    const pending = (
      await request("/v1/pairing/redeem", undefined, {
        offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
        device: { name: "Phone", platform: "ios" },
      })
    ).body as { deviceId: string; completionToken: string };
    const complete = (
      await request("/v1/pairing/complete", undefined, {
        completionToken: pending.completionToken,
        acceptedGrants,
      })
    ).body as { deviceToken: string };
    return { deviceId: pending.deviceId, token: complete.deviceToken };
  };
  const credits = (token?: string) => request(HOSTED_CREDITS_PATH, token);
  return { fleet, request, pair, credits };
}

describe("GET /v1/hosted/credits (VUH-1403)", () => {
  it("answers the owner and any live paired device, Supervise included", async () => {
    const { credits, pair, fleet } = await setup();
    const supervise = await pair(SUPERVISE_GRANTS);
    const control = await pair(TAKE_CONTROL_GRANTS);
    for (const token of ["owner", supervise.token, control.token]) {
      const answer = await credits(token);
      expect(answer.status).toBe(200);
      expect(answer.body).toEqual(BALANCE);
      expect(answer.headers.get("cache-control")).toBe("no-store");
    }
    expect(fleet).toHaveBeenCalledTimes(3);
  });

  it("refuses a stranger, a forged token and a revoked device before asking the fleet", async () => {
    const { credits, pair, request, fleet } = await setup();
    const device = await pair(SUPERVISE_GRANTS);
    expect((await credits(device.token)).status).toBe(200);
    expect((await request(`/v1/devices/${device.deviceId}/revoke`, "owner", {})).status).toBe(200);
    fleet.mockClear();
    for (const token of [undefined, "nobody", `${device.token}x`, device.token]) {
      const answer = await credits(token);
      expect(answer.status).toBe(401);
      expect(answer.body).toEqual({ error: "authentication_required" });
    }
    expect(fleet).not.toHaveBeenCalled();
  });

  it("asks the fleet with one signed body call and relays both pools unchanged", async () => {
    const { credits, fleet } = await setup();
    expect((await credits("owner")).body).toEqual(BALANCE);
    const [url, init] = fleet.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe(FLEET_BODY_CREDITS_PATH);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-clankie-body-signature")).toMatch(/^[A-Za-z0-9_-]{86}$/u);
    expect(JSON.parse(String(init?.body))).toEqual({
      installationId: hostedFixture().bootstrap.installationId,
    });
  });

  it("shows a spent pack, top-ups only, and a low balance exactly as the fleet counts them", async () => {
    const answers = [
      { ...BALANCE, pack: { ...BALANCE.pack, used: 30 }, available: 9 },
      { ...BALANCE, pack: null, topUp: 2.5, available: 2.5, low: true },
      {
        ...BALANCE,
        pack: { ...BALANCE.pack, used: 29 },
        topUp: 0,
        available: 1,
        low: true,
      },
    ];
    const queue = [...answers];
    const { credits } = await setup({
      fleet: async () => Response.json(queue.shift()),
    });
    for (const expected of answers) expect((await credits("owner")).body).toEqual(expected);
  });

  it("answers 503 unavailable when the fleet is unreachable, failing or answers off-contract", async () => {
    const failures: Array<() => Promise<Response>> = [
      async () => {
        throw new TypeError("fetch failed");
      },
      async () => Response.json({ error: "internal" }, { status: 500 }),
      async () => Response.json({ ...BALANCE, topUp: -1 }),
      async () => Response.json({ ...BALANCE, buyUrl: "http://clankie.bot/account" }),
      async () => Response.json({ ...BALANCE, dollars: 12 }),
    ];
    for (const failure of failures) {
      const { credits } = await setup({ fleet: failure });
      const answer = await credits("owner");
      expect(answer.status).toBe(503);
      expect(answer.body).toEqual({ error: "unavailable" });
    }
  });

  it("is absent on a self-hosted body: 404 not_hosted, after authentication", async () => {
    const { credits, pair } = await setup({ hosted: false });
    const device = await pair(SUPERVISE_GRANTS);
    expect(await credits("owner")).toMatchObject({
      status: 404,
      body: { error: "not_hosted" },
    });
    expect(await credits(device.token)).toMatchObject({
      status: 404,
      body: { error: "not_hosted" },
    });
    expect((await credits("nobody")).status).toBe(401);
  });

  it("is a GET the public gateway dispatches to the control plane, and nothing else", () => {
    expect(publicGatewayTargetFor("GET", HOSTED_CREDITS_PATH)).toBe("control");
    expect(publicGatewayTargetFor("POST", HOSTED_CREDITS_PATH)).toBeUndefined();
    expect(publicGatewayTargetFor("GET", FLEET_BODY_CREDITS_PATH)).toBeUndefined();
  });
});
