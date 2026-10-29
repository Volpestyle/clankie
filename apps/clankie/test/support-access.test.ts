import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { ClankieApiClient } from "../../../packages/api-client/src/index.ts";
import { SUPPORT_DEVICE_GRANTS } from "@clankie/protocol/support-access";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { createCaptainConversationDispatch } from "../../relay/src/conversation-upstream.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function listen(server: Server) {
  if (!server.listening) server.listen(0, "127.0.0.1");
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback fixture address");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(history?: { count: number; ended: boolean; restoredActive?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "support-access-"));
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
  let now = 1_790_000_000_000;
  const key = randomBytes(32),
    log = join(root, "events.jsonl");
  const historicalIds: string[] = [];
  if (history !== undefined) {
    const events = [];
    for (let index = 0; index < history.count; index++) {
      const grantId = randomUUID();
      historicalIds.push(grantId);
      const grant = {
        grantId,
        scope: "read-state",
        supportRef: "historical-private-ref",
        status: "active",
        createdAt: new Date(now - (history.ended ? 120_000 : 0)).toISOString(),
        expiresAt: new Date(now + (history.ended ? -60_000 : 60_000)).toISOString(),
      };
      const base = {
        missionId: `support:${grantId}`,
        streamKind: "mission",
        correlationId: grantId,
        profileHash: "fixture",
        occurredAt: grant.createdAt,
      };
      const grantedId = randomUUID();
      events.push(
        { ...base, id: grantedId, type: "support.grant.granted", data: { schemaVersion: 1, grant } },
        {
          ...base,
          id: randomUUID(),
          type: "support.audit.recorded",
          data: { schemaVersion: 1, sourceEventId: grantedId },
        },
      );
      if (history.ended && !(history.restoredActive && index === 0)) {
        const expiredId = randomUUID();
        events.push(
          {
            ...base,
            id: expiredId,
            type: "support.grant.expired",
            data: { schemaVersion: 1, grant: { ...grant, status: "expired" } },
          },
          {
            ...base,
            id: randomUUID(),
            type: "support.audit.recorded",
            data: { schemaVersion: 1, sourceEventId: expiredId },
          },
        );
      }
    }
    writeFileSync(log, events.map((event) => JSON.stringify(event)).join("\n") + "\n", { mode: 0o600 });
  }
  const store = new ConversationStore(
    join(root, "conversations"),
    async () => {},
    undefined,
    undefined,
    2000,
  );
  cleanups.push(() => store.close());
  const created = await store.serve({
    schemaVersion: 1,
    op: "create",
    scope: { kind: "global" },
    title: "Customer history",
  });
  if (created.op !== "create") throw new Error("No fixture conversation");
  const conversationId = created.conversation.conversationId;
  let tailStarted = latch();
  const nextTail = latch();
  let tailCalls = 0;
  let body: ClankieApp;
  const makeBody = async () =>
    createClankieApp({
      captain: createStubCaptain({
        serveOperatorConversation: (request, authority) => {
          if (request.op === "tail") {
            tailStarted.resolve();
            if (++tailCalls >= 2) nextTail.resolve();
          }
          return store.serve(request as Parameters<typeof store.serve>[0], authority);
        },
      }),
      deviceSessionKey: key,
      eventLogPath: log,
      clock: () => new Date(now),
      authenticateOperator: async (r) =>
        r.headers.get("authorization") === "Bearer fixture-owner" ? { operatorId: "owner" } : undefined,
      authenticateCaptain: async (r) =>
        r.headers.get("authorization") === "Bearer fixture-captain-token"
          ? { captainId: "captain", steerSourceLane: "api" }
          : undefined,
    });
  body = await makeBody();
  cleanups.push(async () => body.close());
  const server = serve({
    fetch: (request) => body.app.fetch(request),
    port: 0,
    hostname: "127.0.0.1",
  }) as Server;
  const url = await listen(server);
  const owner = new ClankieApiClient({ baseUrl: url, operatorToken: "fixture-owner" });
  const authorizer = new ControlPlaneDeviceAuthorizer({ baseUrl: url });
  const handler = createOperatorConversationRelayHandler({
    authorizeDevice: authorizer,
    dispatch: createCaptainConversationDispatch({ baseUrl: url, bearerToken: "fixture-captain-token" }),
    tailPollMs: 10,
  });
  const relay = await listen(
    createServer((request, response) => {
      void handler(request, response)
        .then((found) => {
          if (!found) {
            response.statusCode = 404;
            response.end();
          }
        })
        .catch(() => {
          response.statusCode = 500;
          response.end();
        });
    }),
  );
  const post = (path: string, input: unknown, token?: string, origin = url) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(input),
    });
  const pair = async (grantId: string) => {
    const offer = await owner.createSupportPairingOffer(grantId);
    const redeem = await post("/v1/pairing/redeem", {
      offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
      device: { name: "Support tester", platform: "unknown" },
    });
    expect(redeem.status).toBe(200);
    const pending = await redeem.json();
    expect(pending.offeredGrants).toEqual(SUPPORT_DEVICE_GRANTS);
    const widened = await post("/v1/pairing/complete", {
      completionToken: pending.completionToken,
      acceptedGrants: { ...SUPPORT_DEVICE_GRANTS, chat: true },
    });
    expect(widened.status).toBe(400);
    const complete = await post("/v1/pairing/complete", {
      completionToken: pending.completionToken,
      acceptedGrants: SUPPORT_DEVICE_GRANTS,
    });
    expect(complete.status).toBe(200);
    return complete.json() as Promise<{ deviceToken: string; deviceId: string; sessionExpiresAt: string }>;
  };
  return {
    root,
    historicalIds,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    url,
    relay,
    owner,
    store,
    conversationId,
    post,
    pair,
    tail: () => tailStarted.promise,
    nextTail: () => nextTail.promise,
    resetTail: () => {
      tailStarted = latch();
    },
    restart: async () => {
      body.close();
      body = await makeBody();
    },
  };
}

it("enforces owner grant lifecycle, readonly pairing and durable restart over real HTTP", async () => {
  const f = await fixture();
  expect(
    (
      await f.post(
        "/v1/support/grants",
        { scope: "shell", durationSeconds: 60, supportRef: "ref" },
        "fixture-captain-token",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.post(
        "/v1/support/grants",
        { scope: "shell", durationSeconds: 259201, supportRef: "ref" },
        "fixture-owner",
      )
    ).status,
  ).toBe(400);
  const grant = await f.owner.createSupportGrant({
    scope: "read-state",
    durationSeconds: 120,
    supportRef: "CUSTOMER PRIVATE REFERENCE",
  });
  const device = await f.pair(grant.grantId);
  expect(Date.parse(device.sessionExpiresAt)).toBe(Date.parse(grant.expiresAt));
  const read = () =>
    fetch(`${f.url}/v1/devices/self`, { headers: { authorization: `Bearer ${device.deviceToken}` } });
  expect((await read()).status).toBe(200);
  expect(
    (
      await f.post(
        "/v1/support/grants",
        { scope: "shell", durationSeconds: 60, supportRef: "escalate" },
        device.deviceToken,
      )
    ).status,
  ).toBe(403);
  const relay = (op: string) =>
    f.post(
      "/operator/v1/dispatch",
      { schemaVersion: 1, op, ...(op === "get" ? { conversationId: f.conversationId } : {}) },
      device.deviceToken,
      f.relay,
    );
  expect((await relay("list")).status).toBe(200);
  expect((await relay("get")).status).toBe(200);
  expect((await relay("terminal_catalog")).status).toBe(403);
  // The fleet-settings portal has no support read operation and must stay owner-only.
  for (const [method, path] of [
    ["GET", "/v1/operator/fleet-settings"],
    ["POST", "/v1/operator/fleet-settings"],
    ["GET", "/v1/operator/projects?includeAutonomy=true"],
    ["POST", "/v1/operator/projects/update?includeAutonomy=true"],
  ] as const) {
    const result = await fetch(`${f.relay}${path}`, {
      method,
      headers: { authorization: `Bearer ${device.deviceToken}`, "content-type": "application/json" },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    expect(result.status).toBe(403);
  }
  expect(
    (
      await f.post(
        "/operator/v1/dispatch",
        { schemaVersion: 1, op: "create", scope: { kind: "global" }, title: "Write" },
        device.deviceToken,
        f.relay,
      )
    ).status,
  ).toBe(403);
  await f.restart();
  expect((await f.owner.listSupportGrants()).grants).toEqual([grant]);
  expect((await read()).status).toBe(200);
  expect((await f.owner.revokeSupportGrant(grant.grantId)).status).toBe("revoked");
  expect((await read()).status).toBe(401);
  expect((await relay("list")).status).toBe(401);
});

it("refuses shell pairing and closes terminal and file reads for support, including restored shell devices", async () => {
  const f = await fixture();
  const shell = await f.owner.createSupportGrant({
    scope: "shell",
    durationSeconds: 120,
    supportRef: "shell-ref",
  });
  const refused = await f.post(`/v1/support/grants/${shell.grantId}/pairing-offer`, {}, "fixture-owner");
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "support_pairing_requires_read_state" });

  const grant = await f.owner.createSupportGrant({
    scope: "read-state",
    durationSeconds: 120,
    supportRef: "state-ref",
  });
  const device = await f.pair(grant.grantId);
  const self = await fetch(`${f.url}/v1/devices/self`, {
    headers: { authorization: `Bearer ${device.deviceToken}` },
  });
  expect((await self.json()).grants).toEqual({
    chat: false,
    steer: false,
    terminalObserve: false,
    terminalControl: false,
  });
  expect(
    (
      await f.post(
        "/operator/v1/dispatch",
        { schemaVersion: 1, op: "terminal_catalog" },
        device.deviceToken,
        f.relay,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.post(
        "/operator/v1/terminal-tail",
        {
          schemaVersion: 1,
          op: "terminal_tail",
          observation: {
            schemaVersion: 1,
            terminalId: "term-worker",
            surfaceClientId: "support",
            columns: 120,
            rows: 40,
            limit: 1,
          },
        },
        device.deviceToken,
        f.relay,
      )
    ).status,
  ).toBe(403);
  expect(
    (await fetch(`${f.relay}/v1/body-leases`, { headers: { authorization: `Bearer ${device.deviceToken}` } }))
      .status,
  ).toBe(403);
  expect((await f.post("/operator/v1/artifacts/download", {}, device.deviceToken, f.relay)).status).toBe(403);

  // Reproduce an older disk that admitted shell-bound support pairing. Its signed device
  // identity survives restart, but shell authority must not enter the paired read transport.
  const log = join(f.root, "events.jsonl");
  const records = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  for (const record of records)
    if (record.type === "device.activated" && record.data.deviceId === device.deviceId)
      record.data.grants.terminalObserve = true;
  writeFileSync(log, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  await f.restart();
  const refreshed = await f.post("/v1/devices/self/session/refresh", {}, device.deviceToken);
  expect(refreshed.status).toBe(200);
  expect((await refreshed.json()).grants).toEqual(SUPPORT_DEVICE_GRANTS);

  for (const record of records)
    if (record.type === "support.grant.granted" && record.data.grant.grantId === grant.grantId)
      record.data.grant.scope = "shell";
  writeFileSync(log, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  await f.restart();
  expect(
    (await fetch(`${f.url}/v1/devices/self`, { headers: { authorization: `Bearer ${device.deviceToken}` } }))
      .status,
  ).toBe(401);
  expect(
    (
      await f.post(
        "/operator/v1/dispatch",
        { schemaVersion: 1, op: "terminal_catalog" },
        device.deviceToken,
        f.relay,
      )
    ).status,
  ).toBe(401);
});

it("bounds open windows while keeping more than 1024 ended durable grants and rejecting restored expired authority", async () => {
  const historical = await fixture({ count: 1025, ended: true, restoredActive: true });
  const grant = await historical.owner.createSupportGrant({
    scope: "shell",
    durationSeconds: 60,
    supportRef: "new support window",
  });
  const listed = (await historical.owner.listSupportGrants()).grants;
  expect(listed).toHaveLength(1026);
  expect(listed.find((item) => item.grantId === historical.historicalIds[0])?.status).toBe("expired");
  expect(
    (
      await historical.post(
        `/v1/support/grants/${historical.historicalIds[0]}/pairing-offer`,
        {},
        "fixture-owner",
      )
    ).status,
  ).toBe(410);
  expect(listed.find((item) => item.grantId === grant.grantId)?.status).toBe("active");
  const full = await fixture({ count: 1024, ended: false });
  const refused = await full.post(
    "/v1/support/grants",
    { scope: "shell", durationSeconds: 60, supportRef: "too many" },
    "fixture-owner",
  );
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "support_window_capacity" });
});

it("stops an established history stream after authority expires or is revoked", async () => {
  for (const expire of [false, true]) {
    const f = await fixture();
    const grant = await f.owner.createSupportGrant({
      scope: "read-state",
      durationSeconds: 30,
      supportRef: "support-window",
    });
    const device = await f.pair(grant.grantId);
    const sent = await f.store.serve({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId: f.conversationId,
        surfaceClientId: "customer",
        expectedRevision: f.store.conversation(f.conversationId)!.revision,
        message: "PRIVATE HISTORY FIRST",
      },
    });
    if (sent.op !== "send" || sent.result.status !== "accepted") throw new Error("Fixture turn not admitted");
    await f.store.awaitRun(sent.result.runId);
    const response = await f.post(
      "/operator/v1/tail",
      {
        schemaVersion: 1,
        op: "tail",
        tail: {
          schemaVersion: 1,
          conversationId: f.conversationId,
          surfaceClientId: "support",
          limit: 100,
          waitMs: 250,
        },
      },
      device.deviceToken,
      f.relay,
    );
    const reader = response.body!.getReader();
    let received = "";
    while (!received.includes("PRIVATE HISTORY FIRST")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Stream closed before initial history");
      received += new TextDecoder().decode(chunk.value);
    }
    await f.nextTail();
    if (expire) f.advance(31_000);
    else await f.owner.revokeSupportGrant(grant.grantId);
    let after = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      after += new TextDecoder().decode(chunk.value);
    }
    expect(after).toContain("auth_failure");
  }
});

it("suppresses a parked history page after revoke or expiry, including an already admitted stream", async () => {
  for (const expire of [false, true]) {
    const f = await fixture();
    const grant = await f.owner.createSupportGrant({
      scope: "read-state",
      durationSeconds: 30,
      supportRef: "support-issue",
    });
    const device = await f.pair(grant.grantId);
    const replay = await f.store.serve({
      schemaVersion: 1,
      op: "replay",
      replay: { schemaVersion: 1, conversationId: f.conversationId, surfaceClientId: "support", limit: 100 },
    });
    if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("No fixture page");
    const request = {
      schemaVersion: 1,
      op: "tail",
      tail: {
        schemaVersion: 1,
        conversationId: f.conversationId,
        surfaceClientId: "support",
        cursor: replay.result.nextCursor,
        limit: 100,
        waitMs: 250,
      },
    };
    const pending = f.post("/operator/v1/tail", request, device.deviceToken, f.relay);
    await f.tail();
    if (expire) f.advance(31_000);
    else await f.owner.revokeSupportGrant(grant.grantId);
    const response = await pending;
    const text = await response.text();
    expect(text).toContain("auth_failure");
    expect(text).not.toContain('"kind":"event"');
    expect((await f.owner.listSupportGrants()).grants[0]?.status).toBe(expire ? "expired" : "revoked");
  }
});
