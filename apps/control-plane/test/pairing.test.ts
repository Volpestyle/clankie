import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import type { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createControlPlane, type TrustedOperatorIdentity } from "../src/app.ts";

const tempDirs: string[] = [];
let doctrine: Awaited<ReturnType<typeof loadDoctrine>>;

async function loadDoctrine() {
  return compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
}

beforeAll(async () => {
  doctrine = await loadDoctrine();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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

const mintOffer = (app: Hono, token?: string) =>
  app.request("/v1/pairing/offer", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: "{}",
  });

describe("control-plane pairing offer surface", () => {
  it("fails closed when no authenticated operator surface is configured", async () => {
    const app = await createControlPlane({ doctrine });
    const response = await mintOffer(app, "operator-secret");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "operator_authentication_unavailable" });
  });

  it("requires the operator bearer and rejects a wrong credential", async () => {
    const app = await createControlPlane({ doctrine, authenticateOperator: operator });
    expect((await mintOffer(app)).status).toBe(401);
    expect((await mintOffer(app, "wrong-secret")).status).toBe(401);
  });

  it("mints an offer matching the `clankie pair` contract, unique per request", async () => {
    const now = new Date("2026-07-13T12:00:00.000Z");
    const app = await createControlPlane({
      doctrine,
      authenticateOperator: operator,
      clock: () => now,
    });
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

  it("records a secret-free audit event for each minted offer", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-pairing-"));
    tempDirs.push(root);
    const store = new SqliteEventStore(join(root, "events.db"));
    const app = await createControlPlane({
      doctrine,
      eventStore: store,
      authenticateOperator: operator,
      idFactory: () => "deadbeefdeadbeefdeadbeef",
    });
    const response = await mintOffer(app, "operator-secret");
    expect(response.status).toBe(200);
    const offer = ClientPairingOfferSchema.parse(await response.json());

    const minted = (await store.readAll())
      .map((stored) => stored.event)
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
