import { randomBytes, randomUUID, createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
  FileCredentialStore,
  ensureOperatorCredential,
} from "../../../packages/credential-broker/src/index.ts";
import { TAKE_CONTROL_GRANTS } from "../../../packages/protocol/src/index.ts";
import {
  EVIDENCE_STORAGE_SETTINGS_PATH as path,
  EvidenceStorageSnapshotSchema,
} from "../../../packages/protocol/src/owner-settings.ts";
import { SettingsStore } from "../../../packages/settings/src/index.ts";
import { createClankieApp } from "../../clankie/src/app.ts";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../../clankie/src/device-session.ts";
import { EvidenceStore } from "../../clankie/src/evidence-store.ts";
import { createCredentialBackedOperatorAuthenticator } from "../../clankie/src/operator-auth.ts";
import { ControlPlaneDeviceAuthorizer } from "../src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../src/operator-conversations.ts";
import { expect, it } from "vitest";

// Signed lifecycle fixtures exercise production auth/projection, not pairing enrollment.
// Only the malformed-result case corrupts bytes at the HTTP transport boundary.
it("round-trips evidence storage through real relay/core auth and persistence, and refuses unsafe requests/results", async () => {
  const parent = new URL("../../../.local/", import.meta.url);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(new URL("evidence-storage-relay-", parent).pathname);
  const cleanups: Array<() => Promise<void>> = [];
  const urls: string[] = [];
  let complete = false;
  let proof: Record<string, unknown> = { outcome: "failed" };
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
    if (!address || typeof address === "string") throw Error("Loopback listener unavailable");
    const url = `http://127.0.0.1:${address.port}`;
    urls.push(url);
    return url;
  }
  try {
    const settings = new SettingsStore(join(root, "settings.json"));
    await settings.update((current) => ({ ...current, host: { ...current.host, autoUpdate: false } }));
    const before = await settings.load();
    const broker = new FileCredentialStore(join(root, "broker.json"));
    await ensureOperatorCredential({ env: {}, store: broker });
    const authenticateOperator = createCredentialBackedOperatorAuthenticator({
      env: {},
      store: broker,
      identity: { operatorId: "isolated-fixture-owner" },
    });
    const store = EvidenceStore.local(join(root, "evidence"));
    cleanups.push(async () => {
      store.metadata.close();
    });
    const key = randomBytes(32);
    const signer = new DeviceSessionSigner(key);
    const now = Date.now();
    const tokens = Object.fromEntries(
      ["control", "observe"].map((deviceId) => [
        deviceId,
        signer.issue(
          mintDeviceSessionClaims({ deviceId, nowEpochSeconds: Math.floor(now / 1000), ttlSeconds: 600 }),
        ),
      ]),
    );
    const events = ["control", "observe"].flatMap((deviceId) => {
      const grants = { ...TAKE_CONTROL_GRANTS, terminalControl: deviceId === "control" };
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
          data: {
            schemaVersion: 1,
            deviceId,
            grants,
            sessionExpiresAt: new Date(now + 600_000).toISOString(),
          },
        },
      ];
    });
    const eventLogPath = join(root, "events.jsonl");
    await writeFile(eventLogPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n", {
      mode: 0o600,
    });
    let captainCalls = 0;
    const service = await createClankieApp({
      captain: createStubCaptain({
        serveOperatorConversation: async () => {
          captainCalls++;
          throw Error("No captain authority");
        },
      }),
      settings,
      evidenceStore: store,
      authenticateOperator,
      eventLogPath,
      deviceSessionKey: key,
    });
    cleanups.push(async () => {
      await service.close();
    });
    let corruptResult = false;
    let coreSettingsRequests = 0;
    const coreUrl = await listen(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(name, value);
        else value?.forEach((entry) => headers.append(name, entry));
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const result = await service.app.fetch(
        new Request(`http://${request.headers.host}${request.url}`, {
          method: request.method ?? "GET",
          headers,
          ...(body ? { body } : {}),
        }),
      );
      if (request.url === path) coreSettingsRequests++;
      response.statusCode = result.status;
      result.headers.forEach((value, name) => response.setHeader(name, value));
      // Consume the actual authorized core response before transport corruption.
      const bytes = Buffer.from(await result.arrayBuffer());
      response.end(
        corruptResult && request.url === path && result.ok
          ? JSON.stringify({ schemaVersion: 1, privateUnexpected: "withheld" })
          : bytes,
      );
    });
    const forwarded: Array<{ token: string; method: string }> = [];
    const handler = createOperatorConversationRelayHandler({
      authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl: coreUrl }),
      dispatch: async () => {
        captainCalls++;
        throw Error("No captain dispatch");
      },
      roomRequest: async (route, method, token, body) => {
        forwarded.push({ token, method });
        return fetch(new URL(route, coreUrl), {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(body === undefined ? {} : { body }),
          redirect: "error",
        });
      },
    });
    const relayUrl = await listen(async (request, response) => {
      if (!(await handler(request, response))) {
        response.statusCode = 404;
        response.end();
      }
    });
    const call = (body?: unknown, token = tokens.control, method = body === undefined ? "GET" : "POST") =>
      fetch(relayUrl + path, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      });
    const initialResponse = await call();
    expect(initialResponse.status).toBe(200);
    expect(initialResponse.headers.get("cache-control")).toBe("no-store");
    const initial = EvidenceStorageSnapshotSchema.parse(await initialResponse.json());
    expect(initial).toMatchObject({
      configured: { backend: "local" },
      active: { backend: "local" },
      restartRequired: false,
    });
    expect(initial.revision).toBe(createHash("sha256").update(JSON.stringify(before)).digest("hex"));
    const configured = {
      backend: "s3",
      bucket: "isolated-fixture-bucket",
      region: "us-east-1",
      prefix: "evidence",
    };
    const update = { schemaVersion: 1, expectedRevision: initial.revision, configured };
    const savedResponse = await call(update);
    expect(savedResponse.status).toBe(200);
    const saved = EvidenceStorageSnapshotSchema.parse(await savedResponse.json());
    expect(saved).toMatchObject({ configured, active: { backend: "local" }, restartRequired: true });
    expect(saved.revision).not.toBe(initial.revision);
    const persisted = await new SettingsStore(settings.path).load();
    expect(persisted).toEqual({ ...before, evidence: configured });
    expect(saved.revision).toBe(createHash("sha256").update(JSON.stringify(persisted)).digest("hex"));
    expect(EvidenceStorageSnapshotSchema.parse(await (await call()).json())).toEqual(saved);
    expect(store.storage.activeDestination).toEqual({ backend: "local" });
    const unchanged = await readFile(settings.path, "utf8");
    const stale = await call(update);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "settings_upstream_refused" });
    const hops = forwarded.length;
    for (const method of ["GET", "POST"])
      expect(
        (
          await call(
            method === "POST" ? { ...update, expectedRevision: saved.revision } : undefined,
            tokens.observe,
            method,
          )
        ).status,
      ).toBe(403);
    for (const invalid of [
      "{",
      { ...update, configured: { backend: "local", root: "/escape" } },
      { ...update, configured: { ...configured, secretAccessKey: "rejected" } },
      { ...update, configured: { ...configured, prefix: "../escape" } },
    ]) {
      const response = await call(invalid);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_settings_update" });
    }
    expect((await call("x".repeat(1024 * 1024 + 1))).status).toBe(400);
    expect((await call(undefined, "invalid")).status).toBe(401);
    expect(forwarded.length).toBe(hops);
    const requests = coreSettingsRequests;
    corruptResult = true;
    const malformed = await call();
    expect(malformed.status).toBe(502);
    expect(await malformed.json()).toEqual({ error: "invalid_settings_response" });
    expect(coreSettingsRequests).toBe(requests + 1);
    expect(forwarded.every((entry) => entry.token === tokens.control)).toBe(true);
    expect(captainCalls).toBe(0);
    expect(await readFile(settings.path, "utf8")).toBe(unchanged);
    complete = true;
    proof = {
      proof: "real-loopback-relay-core",
      signedLifecycleFixture: true,
      pairingEnrollment: false,
      fullStartup: false,
      hostedGatewayDeployment: false,
      activeBackend: "local",
      cloudCalls: 0,
      settingsHops: coreSettingsRequests,
      statuses: {
        read: initialResponse.status,
        save: savedResponse.status,
        stale: stale.status,
        forbidden: 403,
        invalid: 400,
        malformedResult: malformed.status,
      },
      currentRevision: saved.revision,
      unchangedSettingsPreserved: true,
      restartRequired: saved.restartRequired,
      originalDeviceOnly: true,
      malformedResult: "HTTP transport corruption after real core response",
      outcome: "passed",
    };
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup();
    await rm(root, { recursive: true, force: true });
    for (const url of urls) await expect(fetch(url + path)).rejects.toThrow();
    expect(existsSync(root)).toBe(false);
    const result = {
      ...proof,
      cleanup: "complete",
      fixtureRootRemoved: true,
      closedListeners: urls.length,
      assertionsCompleted: complete,
      checkedAt: new Date().toISOString(),
    };
    console.info(JSON.stringify(result));
    if (process.env.EVIDENCE_STORAGE_RELAY_PROOF_OUTPUT)
      await writeFile(
        process.env.EVIDENCE_STORAGE_RELAY_PROOF_OUTPUT,
        JSON.stringify(result, null, 2) + "\n",
        { mode: 0o600 },
      );
  }
});
