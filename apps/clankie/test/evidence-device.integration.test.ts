import { randomUUID, randomBytes, createHash } from "node:crypto";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
} from "@clankie/protocol";
import { expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { EvidenceStore } from "../src/evidence-store.ts";

const actor = { kind: "worker" as const, id: "worker-1", name: "Sorrel", onBehalfOf: [] };

async function record(store: EvidenceStore, bytes: Buffer, fileName: string, contentType: string) {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const receipt = await store.upload(actor, {
    idempotencyKey: `key-${sha256.slice(0, 24)}`,
    sha256,
    size: bytes.length,
    contentType,
    fileName,
    issueKey: "VUH-1936 VUH-1954",
    caption: `Proof: ${fileName}`,
  });
  await store.acceptBlob(
    EvidenceStore.actorKey(actor),
    receipt.receiptId,
    (async function* () {
      yield bytes;
    })(),
  );
  return sha256;
}

it("shows a paired device an issue's recorded evidence and small previews, never a link to the service", async () => {
  const store = EvidenceStore.local(await mkdtemp(join(tmpdir(), "evidence-device-")));
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32, 1)]);
  const pngSha = await record(store, png, "docs/testing/shot.png", "image/png");
  const logSha = await record(store, Buffer.from("round trip ok\n"), "docs/testing/run.txt", "text/plain");
  const { app } = await createClankieApp({
    captain: createStubCaptain(),
    evidenceStore: store,
    authenticateOperator: async () => ({ operatorId: "owner" }),
    authenticateCaptain: async () => ({ captainId: "operator", steerSourceLane: "api" }),
  });
  const dispatch = async (body: unknown) => {
    const response = await app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
  const listed = await dispatch({ op: "evidence_records", schemaVersion: 1, issueKey: "VUH-1954" });
  expect(listed).toMatchObject({
    result: {
      outcome: "ready",
      records: expect.arrayContaining([
        expect.objectContaining({
          sha256: pngSha,
          caption: "Proof: docs/testing/shot.png",
          actor: expect.objectContaining({ name: "Sorrel" }),
        }),
        expect.objectContaining({ sha256: logSha, url: `clankie://evidence/sha256/${logSha}` }),
      ]),
    },
  });
  expect(await dispatch({ op: "evidence_preview", schemaVersion: 1, sha256: pngSha })).toMatchObject({
    result: { outcome: "ready", available: true, contentType: "image/png", data: png.toString("base64") },
  });
  expect(await dispatch({ op: "evidence_preview", schemaVersion: 1, sha256: logSha })).toMatchObject({
    result: { outcome: "ready", available: true, text: "round trip ok\n" },
  });
  expect(await dispatch({ op: "evidence_preview", schemaVersion: 1, sha256: "0".repeat(64) })).toMatchObject({
    result: { outcome: "unavailable" },
  });
  store.close();
});

it("streams bounded recorded bytes only to a paired owner device and refuses revoked or lesser grants", async () => {
  const { DeviceSessionSigner, mintDeviceSessionClaims } = await import("../src/device-session.ts");
  const { TAKE_CONTROL_GRANTS, SUPERVISE_GRANTS } = await import("@clankie/protocol");
  const root = await mkdtemp(join(tmpdir(), "evidence-fetch-device-"));
  const store = EvidenceStore.local(join(root, "evidence"));
  const bytes = Buffer.alloc(300_000, 7);
  bytes[262_143] = 13;
  bytes[262_144] = 21;
  const sha256 = await record(store, bytes, "demo.mp4", "video/mp4");
  const key = randomBytes(32),
    signer = new DeviceSessionSigner(key),
    now = Math.floor(Date.now() / 1000) * 1000;
  const eventPath = join(root, "events.jsonl");
  const events = ["owner", "reader"].flatMap((deviceId) => {
    const grants = deviceId === "owner" ? TAKE_CONTROL_GRANTS : SUPERVISE_GRANTS;
    const base = {
      occurredAt: new Date(now).toISOString(),
      missionId: `device:${deviceId}`,
      correlationId: "fixture",
      profileHash: "fixture",
    };
    return [
      {
        ...base,
        id: randomUUID(),
        type: "device.pairing.redeemed",
        data: {
          schemaVersion: 1,
          deviceId,
          offerId: deviceId,
          name: deviceId,
          platform: "ios",
          offeredGrants: grants,
          mintedBy: "local-operator",
          pendingExpiresAt: new Date(now + 600_000).toISOString(),
        },
      },
      {
        ...base,
        id: randomUUID(),
        type: "device.activated",
        data: { schemaVersion: 1, deviceId, grants, sessionExpiresAt: new Date(now + 600_000).toISOString() },
      },
    ];
  });
  await writeFile(eventPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const { app } = await createClankieApp({
    captain: createStubCaptain(),
    evidenceStore: store,
    eventLogPath: eventPath,
    deviceSessionKey: key,
    clock: () => new Date(now),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer operator" ? { operatorId: "owner" } : undefined,
  });
  const token = (id: string) =>
    signer.issue(mintDeviceSessionClaims({ deviceId: id, nowEpochSeconds: now / 1000, ttlSeconds: 600 }));
  const fetch = (bearer: string, offset: number, length: number, hash = sha256) =>
    app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "evidence_fetch", schemaVersion: 1, sha256: hash, offset, length }),
    });
  for (const offset of [0, 262_144, 300_000]) {
    const response = await fetch(token("owner"), offset, 262_144);
    expect(response.status).toBe(200);
    const value = OperatorConversationServiceResultSchema.parse(await response.json());
    if (value.op !== "evidence_fetch" || value.result.outcome !== "ready")
      throw new Error("Expected evidence bytes");
    expect(value.result.contentType).toBe("video/mp4");
    expect(value.result.size).toBe(bytes.length);
    expect(Buffer.from(value.result.data, "base64")).toEqual(bytes.subarray(offset, offset + 262_144));
    expect(value.result).not.toHaveProperty("url");
  }
  expect((await fetch(token("reader"), 0, 1)).status).toBe(403);
  expect((await fetch("operator", 0, 1)).status).toBe(403);
  expect((await fetch(token("owner"), 0, 262_145)).status).toBe(400);
  expect(await (await fetch(token("owner"), 0, 1, "0".repeat(64))).json()).toMatchObject({
    result: { outcome: "unavailable" },
  });
  await app.request("/v1/devices/owner/revoke", {
    method: "POST",
    headers: { authorization: "Bearer operator" },
  });
  expect((await fetch(token("owner"), 0, 1)).status).toBe(403);
  store.close();
});
