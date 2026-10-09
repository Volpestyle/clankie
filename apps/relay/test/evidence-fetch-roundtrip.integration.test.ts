import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  OperatorConversationServiceResultSchema,
  SUPERVISE_GRANTS,
  TAKE_CONTROL_GRANTS,
} from "../../../packages/protocol/src/index.ts";
import { createClankieApp } from "../../clankie/src/app.ts";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../../clankie/src/device-session.ts";
import { EvidenceStore } from "../../clankie/src/evidence-store.ts";
import {
  createCaptainConversationDispatch,
  createDeviceConversationDispatch,
} from "../src/conversation-upstream.ts";
import { ControlPlaneDeviceAuthorizer } from "../src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../src/operator-conversations.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => Promise<unknown>) {
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture TCP listener");
  return `http://127.0.0.1:${address.port}`;
}

const actor = { kind: "worker" as const, id: "worker-1", name: "Sorrel", onBehalfOf: [] };

it("relays evidence_fetch ranges to a paired owner device under its own identity and refuses unpaired or lesser devices (VUH-1977)", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-evidence-fetch-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = EvidenceStore.local(join(root, "evidence"));
  cleanups.push(async () => store.close());
  // Bytes that the relay's string redaction would rewrite if it touched the payload.
  const bytes = Buffer.concat([Buffer.from("sk-ant-api03-" + "A".repeat(80)), randomBytes(300_000)]);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const receipt = await store.upload(actor, {
    idempotencyKey: `key-${sha256.slice(0, 24)}`,
    sha256,
    size: bytes.length,
    contentType: "video/mp4",
    fileName: "demo.mp4",
    issueKey: "VUH-1977",
  });
  await store.acceptBlob(
    EvidenceStore.actorKey(actor),
    receipt.receiptId,
    (async function* () {
      yield bytes;
    })(),
  );

  const key = randomBytes(32);
  const signer = new DeviceSessionSigner(key);
  const now = Math.floor(Date.now() / 1000) * 1000;
  const paired = ["owner", "reader"] as const;
  const events = paired.flatMap((deviceId) => {
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
          mintedBy: "local-owner",
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
  const eventLogPath = join(root, "events.jsonl");
  await writeFile(eventLogPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const service = await createClankieApp({
    captain: createStubCaptain(),
    evidenceStore: store,
    eventLogPath,
    deviceSessionKey: key,
    clock: () => new Date(now),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-owner" ? { operatorId: "owner" } : undefined,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-captain-token"
        ? { captainId: "captain", steerSourceLane: "api" }
        : undefined,
  });
  cleanups.push(async () => service.close());
  const controlUrl = await listen(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (value) for (const entry of value) headers.append(name, entry);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    const result = await service.app.fetch(
      new Request(`http://${request.headers.host}${request.url}`, {
        method: request.method ?? "GET",
        headers,
        ...(body ? { body } : {}),
      }),
    );
    response.statusCode = result.status;
    result.headers.forEach((value, name) => response.setHeader(name, value));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  const upstream: { path: string; token: string | null; op?: string }[] = [];
  const controlFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = request.method === "POST" ? ((await request.clone().json()) as { op?: string }) : undefined;
    upstream.push({
      path: new URL(request.url).pathname,
      token: request.headers.get("authorization"),
      ...(body?.op ? { op: body.op } : {}),
    });
    return fetch(request);
  };
  const dispatch = vi.fn(
    createCaptainConversationDispatch({
      baseUrl: controlUrl,
      bearerToken: "fixture-captain-token",
      fetch: controlFetch,
    }),
  );
  const relayUrl = await listen(
    createOperatorConversationRelayHandler({
      authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl: controlUrl, fetch: controlFetch }),
      dispatch,
      deviceDispatch: createDeviceConversationDispatch({ baseUrl: controlUrl, fetch: controlFetch }),
      logger: { info: () => undefined, warn: () => undefined },
    }),
  );
  const token = (deviceId: string) =>
    signer.issue(mintDeviceSessionClaims({ deviceId, nowEpochSeconds: now / 1000, ttlSeconds: 600 }));
  const fetchRange = (bearer: string, offset: number, length: number) =>
    fetch(`${relayUrl}/operator/v1/dispatch`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ op: "evidence_fetch", schemaVersion: 1, sha256, offset, length }),
    });

  // A paired owner device reads every range byte-exact, the tail included.
  const owner = token("owner");
  for (const offset of [0, 262_144, bytes.length - 100]) {
    const response = await fetchRange(owner, offset, 262_144);
    expect(response.status).toBe(200);
    const value = OperatorConversationServiceResultSchema.parse(await response.json());
    if (value.op !== "evidence_fetch" || value.result.outcome !== "ready")
      throw new Error("Expected evidence bytes");
    expect(value.result).toMatchObject({ offset, size: bytes.length, contentType: "video/mp4" });
    expect(Buffer.from(value.result.data, "base64")).toEqual(bytes.subarray(offset, offset + 262_144));
    expect(value.result).not.toHaveProperty("url");
  }
  // The read went to the service as the device itself, never as the captain.
  const fetches = upstream.filter((entry) => entry.op === "evidence_fetch");
  expect(fetches.length).toBe(3);
  expect(fetches.every((entry) => entry.token === `Bearer ${owner}`)).toBe(true);
  expect(dispatch).not.toHaveBeenCalled();

  // A device that was never paired is refused at the relay; a supervise-only device by the service.
  expect((await fetchRange(token("never-paired"), 0, 1)).status).toBe(401);
  expect((await fetchRange(token("reader"), 0, 1)).status).toBe(403);
  // After revocation the same owner token reads nothing.
  await fetch(`${controlUrl}/v1/devices/owner/revoke`, {
    method: "POST",
    headers: { authorization: "Bearer fixture-owner" },
  });
  expect((await fetchRange(owner, 0, 1)).status).toBe(401);
  expect(dispatch).not.toHaveBeenCalled();
});
