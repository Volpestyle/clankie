import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { SUPERVISE_GRANTS } from "@clankie/protocol";
import { SUPPORT_DEVICE_GRANTS } from "@clankie/protocol/support-access";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import {
  composerHttpFixture as fixture,
  composerWavFixture as wav,
  closeComposerFixtures,
} from "./fixtures/composer-http.ts";
afterEach(closeComposerFixtures);

it("transcribes bounded WAV chunks through genuine paired-device encryption, preserves private content and dispatches a UUID once", async () => {
  const f = await fixture();
  expect((await f.api.status()).state).toBe("available");
  const id = await f.upload(wav(180));
  const result = await f.api.commit(id);
  expect(result).toMatchObject({ state: "complete", text: "Draft words 🪴" });
  expect(await f.api.commit(id)).toEqual(result);
  expect(f.spent()).toBe(1);
  expect(f.attestations.at(-1)).toMatchObject({
    deviceId: f.device.deviceId,
    chat: true,
    support: false,
  });
  expect(f.attestations.at(-1)).not.toHaveProperty("installationId");
  expect(f.attestations.at(-1)?.authKeyId).toMatch(/^[A-Za-z0-9_-]{22}$/u);
  expect(readdirSync(join(f.root, "composer/audio"))).toEqual([]);
  expect(f.outer.join(" ")).not.toContain("PRIVATE_AUDIO_MARKER");
  expect(f.outer.join(" ")).not.toContain("Draft words");
  expect(readFileSync(join(f.root, "events.jsonl"), "utf8")).not.toContain("Draft words");
  expect(readFileSync(join(f.root, "composer/requests.sqlite")).includes(Buffer.from("Draft words"))).toBe(
    false,
  );
  for (const token of ["owner", "captain"])
    expect(
      (
        await fetch(`${f.bodyUrl}/v1/composer/transcription/status`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401);
  f.status("allowance_exhausted");
  expect((await f.api.status()).state).toBe("allowance_exhausted");
  await expect(f.api.begin({ requestId: randomUUID(), audioBytes: 46 })).rejects.toMatchObject({
    status: 403,
  });
  expect(f.spent()).toBe(1);
  const other = await f.pair();
  expect(
    (
      await fetch(`${f.bodyUrl}/v1/composer/transcription/receipt`, {
        method: "POST",
        headers: { authorization: `Bearer ${other.token}`, "content-type": "application/json" },
        body: JSON.stringify({ requestId: id }),
      })
    ).status,
  ).toBe(404);
});

it("refuses malformed audio, expired/read-only/revoked sessions before spend and suppresses cancelled late drafts", async () => {
  const f = await fixture();
  const invalid = wav();
  invalid.writeUInt16LE(3, 20);
  await expect(f.api.commit(await f.upload(invalid))).rejects.toMatchObject({ status: 400 });
  await expect(f.api.commit(await f.upload(wav(180.001)))).rejects.toMatchObject({ status: 400 });
  expect(f.spent()).toBe(0);
  const expired = new DeviceSessionSigner(f.key).issue(
    mintDeviceSessionClaims({
      deviceId: f.device.deviceId,
      nowEpochSeconds: Math.floor(f.now() / 1000) - 10,
      ttlSeconds: 1,
    }),
  );
  expect(
    (
      await fetch(`${f.bodyUrl}/v1/composer/transcription/status`, {
        headers: { authorization: `Bearer ${expired}` },
      })
    ).status,
  ).toBe(401);
  const observer = await f.pair({ ...SUPERVISE_GRANTS, chat: false });
  expect(
    (
      await fetch(`${f.bodyUrl}/v1/composer/transcription/status`, {
        headers: { authorization: `Bearer ${observer.token}` },
      })
    ).status,
  ).toBe(401);
  const support = await f.pair(SUPPORT_DEVICE_GRANTS, "owner", await f.createSupportGrant());
  expect(
    (
      await fetch(`${f.bodyUrl}/v1/composer/transcription/status`, {
        headers: { authorization: `Bearer ${support.token}` },
      })
    ).status,
  ).toBe(401);
  expect(f.spent()).toBe(0);
  // A fresh encrypted ticket for the original device is restored by a real pairing round trip.
  const second = await fixture(),
    held = second.hold(),
    id = await second.upload(wav());
  const pending = second.api.commit(id);
  await held.entered;
  expect((await second.api.cancel(id)).state).toBe("cancelled");
  held.release();
  expect((await pending).text).toBeUndefined();
  expect((await second.api.receipt(id)).state).toBe("cancelled");
  expect(readdirSync(join(second.root, "composer/audio"))).toEqual([]);
  const before = second.spent();
  await fetch(`${second.bodyUrl}/v1/devices/${second.device.deviceId}/revoke`, {
    method: "POST",
    headers: { authorization: "Bearer owner" },
  });
  expect(
    (
      await fetch(`${second.bodyUrl}/v1/composer/transcription/status`, {
        headers: { authorization: `Bearer ${second.device.token}` },
      })
    ).status,
  ).toBe(401);
  expect(second.spent()).toBe(before);
});

it("reclaims the SQLite request capacity at 24 hours while keeping the ten-minute audio lifetime", async () => {
  const f = await fixture();
  const database = () => new DatabaseSync(join(f.root, "composer/requests.sqlite"));
  const seeded = database();
  seeded
    .prepare(`WITH RECURSIVE ids(value) AS (
    SELECT 1 UNION ALL SELECT value+1 FROM ids WHERE value<100000
  ) INSERT INTO requests(id,device,bytes,received,expires,state)
  SELECT printf('00000000-0000-4000-8000-%012d',value),?,46,0,?,'cancelled' FROM ids`)
    .run(f.device.deviceId, f.now() + 10 * 60_000);
  seeded.close();
  await expect(f.api.begin({ requestId: randomUUID(), audioBytes: 46 })).rejects.toMatchObject({
    status: 429,
  });
  f.advance(24 * 60 * 60_000 - 1);
  await expect(f.api.begin({ requestId: randomUUID(), audioBytes: 46 })).rejects.toMatchObject({
    status: 429,
  });
  f.advance(2);
  const resumed = await f.upload(wav());
  const reclaimed = database();
  expect(reclaimed.prepare("SELECT count(*) AS total FROM requests").get()?.total).toBe(1);
  reclaimed.close();
  await expect(f.api.receipt("00000000-0000-4000-8000-000000000001")).rejects.toMatchObject({ status: 404 });
  expect(f.spent()).toBe(0);
  f.advance(10 * 60_000);
  expect((await f.api.receipt(resumed)).state).toBe("cancelled");
  expect(readdirSync(join(f.root, "composer/audio"))).toEqual([]);
});

it("confirms the real support marker in signed fleet state before session mint, restores it and refuses composer authority", async () => {
  const f = await fixture(),
    grantId = await f.createSupportGrant();
  f.hideSupportAcknowledgement(true);
  let pending!: { status: number; completionToken: string };
  try {
    await f.pair(SUPPORT_DEVICE_GRANTS, "owner", grantId);
  } catch (error) {
    pending = error as typeof pending;
  }
  expect(pending.status).toBe(503);
  const marker = f.supportDevices[0]!;
  expect(marker.grant).toBe(grantId);
  const devices = await (
    await fetch(`${f.bodyUrl}/v1/devices`, {
      headers: { authorization: "Bearer owner" },
    })
  ).json();
  expect(devices.find((entry: { deviceId: string }) => entry.deviceId === marker.dev).status).toBe("pending");
  f.hideSupportAcknowledgement(false);
  const support = await f.finishPairing(pending.completionToken, SUPPORT_DEVICE_GRANTS);
  expect(support.deviceId).toBe(marker.dev);
  await f.restart();
  expect(f.supportDevices).toHaveLength(1);
  const response = await fetch(`${f.bodyUrl}/v1/composer/transcription/status`, {
    headers: { authorization: `Bearer ${support.token}` },
  });
  expect(response.status).toBe(401);
  expect(f.spent()).toBe(0);
});

it("cleans restart/TTL captures and never resends audio after a lost provider receipt or body restart", async () => {
  const f = await fixture(),
    id = await f.upload(wav());
  f.lose();
  expect((await f.api.commit(id)).state).toBe("uncertain");
  expect(f.spent()).toBe(1);
  const pending = await f.upload(wav());
  await f.restart();
  expect(readdirSync(join(f.root, "composer/audio"))).toEqual([]);
  expect((await f.api.receipt(pending)).state).toBe("cancelled");
  expect((await f.api.commit(id)).state).toBe("uncertain");
  expect((await f.api.receipt(id)).state).toBe("uncertain");
  expect(f.spent()).toBe(1);
  const expired = await f.upload(wav());
  f.advance(11 * 60_000);
  expect((await f.api.receipt(expired)).state).toBe("cancelled");
  expect(readdirSync(join(f.root, "composer/audio"))).toEqual([]);
  const inflight = await fixture(),
    held = inflight.hold(),
    admitted = await inflight.upload(wav());
  const late = inflight.api.commit(admitted);
  await held.entered;
  await inflight.restart();
  held.release();
  expect((await late).text).toBeUndefined();
  expect((await inflight.api.receipt(admitted)).state).toBe("uncertain");
  expect((await inflight.api.commit(admitted)).state).toBe("uncertain");
  expect(inflight.spent()).toBe(1);
  const local = await fixture(false);
  expect(await local.api.status()).toMatchObject({ mode: "local", state: "ineligible" });
  await expect(local.api.begin({ requestId: randomUUID(), audioBytes: 46 })).rejects.toMatchObject({
    status: 403,
  });
  expect(local.spent()).toBe(0);
});

it("returns a known allowance refusal for local recovery while server uncertainty never resends audio", async () => {
  const f = await fixture();
  const refused = await f.upload(wav());
  f.status("allowance_exhausted");
  const failure = await f.api.commit(refused);
  expect(failure).toMatchObject({ state: "failed", error: "allowance_exhausted" });
  expect(failure.text).toBeUndefined();
  f.status("available");
  expect(await f.api.commit(refused)).toEqual(failure);
  expect(await f.api.receipt(refused)).toEqual(failure);
  expect(f.spent()).toBe(0);
  const uncertain = await f.upload(wav());
  f.status("unavailable");
  expect(await f.api.commit(uncertain)).toMatchObject({ state: "uncertain" });
  f.status("available");
  expect(await f.api.commit(uncertain)).toMatchObject({ state: "uncertain" });
  expect(f.spent()).toBe(0);
  expect(readdirSync(join(f.root, "composer/audio"))).toEqual([]);
});

it("bounds new uploads per device, per minute and machine-wide before any provider spend, and frees them on cancel or after a minute", async () => {
  const f = await fixture();
  // Each paired device calls the body with its own session, as its app does.
  const call = async (token: string, action: "begin" | "cancel", requestId: string) => {
    const response = await fetch(`${f.bodyUrl}/v1/composer/transcription/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(action === "begin" ? { requestId, audioBytes: 46 } : { requestId }),
    });
    return { status: response.status, body: (await response.json()) as { error?: string; state?: string } };
  };
  const begin = (token: string, requestId = randomUUID()) => call(token, "begin", requestId);
  const owner = f.device.token;

  // Two uploads at once per device; the encrypted app transport sees the same refusal.
  const first = randomUUID(),
    held = randomUUID();
  expect((await begin(owner, first)).body.state).toBe("uploading");
  expect((await begin(owner, held)).body.state).toBe("uploading");
  await expect(f.api.begin({ requestId: randomUUID(), audioBytes: 46 })).rejects.toMatchObject({
    status: 429,
    message: "capacity",
  });
  expect((await call(owner, "cancel", first)).body.state).toBe("cancelled");
  // Six starts per device per minute, counted even when cancelled; refusals do not count.
  for (let started = 3; started <= 6; started++) {
    const id = randomUUID();
    expect((await begin(owner, id)).body.state).toBe("uploading");
    expect((await call(owner, "cancel", id)).status).toBe(200);
  }
  expect(await begin(owner)).toEqual({ status: 429, body: { error: "capacity" } });
  f.advance(59_999);
  expect((await begin(owner)).status).toBe(429);
  f.advance(1);
  expect((await begin(owner)).body.state).toBe("uploading");

  // Eight uploads at once across the machine: with the owner's two, three more devices
  // fill it, and a fifth device is refused until one finishes.
  for (let device = 0; device < 3; device++) {
    const { token } = await f.pair();
    expect((await begin(token)).body.state).toBe("uploading");
    expect((await begin(token)).body.state).toBe("uploading");
  }
  const late = await f.pair();
  expect(await begin(late.token)).toEqual({ status: 429, body: { error: "capacity" } });
  expect((await call(owner, "cancel", held)).body.state).toBe("cancelled");
  expect((await begin(late.token)).body.state).toBe("uploading");
  expect(f.spent()).toBe(0);
});

it("rechecks the live support window after hosted publication before minting a session", async () => {
  for (const end of ["revoked", "expired"] as const) {
    const f = await fixture(),
      grantId = await f.createSupportGrant(30),
      held = f.holdSupportPublication(),
      pending = f.pair(SUPPORT_DEVICE_GRANTS, "owner", grantId).catch((error: unknown) => error);
    await held.entered;
    if (end === "revoked") {
      const revoke = await fetch(`${f.bodyUrl}/v1/support/grants/${grantId}/revoke`, {
        method: "POST",
        headers: { authorization: "Bearer owner" },
      });
      expect(revoke.status).toBe(200);
    } else f.advance(30_001);
    held.release();
    expect(await pending).toMatchObject({ status: 410 });
    const marker = f.supportDevices[0]!;
    const devices = await (
      await fetch(`${f.bodyUrl}/v1/devices`, { headers: { authorization: "Bearer owner" } })
    ).json();
    expect(devices.find((entry: { deviceId: string }) => entry.deviceId === marker.dev).status).toBe(
      "pending",
    );
    const events = readFileSync(join(f.root, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      events.filter((event) => event.type === "device.activated" && event.data.deviceId === marker.dev),
    ).toEqual([]);
    expect(f.spent()).toBe(0);
  }
});

it.each([
  ["GET", "/v1/devices/self"],
  ["POST", "/v1/devices/self/session/refresh"],
] as const)(
  "denies %s %s when the device is revoked during signed provenance publication",
  async (method, path) => {
    const f = await fixture(),
      grantId = await f.createSupportGrant(),
      support = await f.pair(SUPPORT_DEVICE_GRANTS, "owner", grantId),
      held = f.holdSupportState(),
      pending = fetch(`${f.bodyUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${support.token}` },
      });
    await held.entered;
    const revoke = await fetch(`${f.bodyUrl}/v1/devices/${support.deviceId}/revoke`, {
      method: "POST",
      headers: { authorization: "Bearer owner" },
    });
    expect(revoke.status).toBe(200);
    const grants = await (
      await fetch(`${f.bodyUrl}/v1/support/grants`, { headers: { authorization: "Bearer owner" } })
    ).json();
    expect(grants.grants.find((grant: { grantId: string }) => grant.grantId === grantId).status).toBe(
      "active",
    );
    held.release();
    const response = await pending;
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "revoked" });
    const events = readFileSync(join(f.root, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const revokedAt = events.findIndex(
      (event) => event.type === "device.revoked" && event.data.deviceId === support.deviceId,
    );
    expect(revokedAt).toBeGreaterThanOrEqual(0);
    expect(
      events
        .slice(revokedAt + 1)
        .filter((event) => event.type === "device.seen" && event.data.deviceId === support.deviceId),
    ).toEqual([]);
    expect(f.spent()).toBe(0);
  },
);
