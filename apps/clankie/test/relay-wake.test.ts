import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATOR_DELIVERED_FILE_DOWNLOAD_PATH, SUPERVISE_GRANTS } from "@clankie/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";
import { createClankieApp, type ClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";

const roots: string[] = [];
const apps: ClankieApp[] = [];
const servers: Server[] = [];
const owner = { authorization: "Bearer wake-test-owner" };
const list = { op: "list", schemaVersion: 1 };
const download = { schemaVersion: 1, conversationId: "global-default", artifactId: "file-1" };

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const app of apps.splice(0)) app.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relay-wake-"));
  roots.push(root);
  const boot = async () => {
    const app = await createClankieApp({
      captain: createStubCaptain(),
      eventLogPath: join(root, "events.jsonl"),
      deviceSessionKey: new Uint8Array(32).fill(7),
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === owner.authorization ? { operatorId: "owner" } : undefined,
    });
    apps.push(app);
    return app;
  };
  let control = await boot();
  const offer = await (
    await control.app.request("/v1/pairing/offer", { method: "POST", headers: owner })
  ).json();
  const redeemed = await (
    await control.app.request("/v1/pairing/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
        device: { name: "Wake test", platform: "ios" },
      }),
    })
  ).json();
  const completed = await (
    await control.app.request("/v1/pairing/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ completionToken: redeemed.completionToken, acceptedGrants: SUPERVISE_GRANTS }),
    })
  ).json();
  const token: string = completed.deviceToken;
  let available = true;
  let didAuthorize!: () => void;
  let authorized = new Promise<void>((resolve) => {
    didAuthorize = resolve;
  });
  const authorizer = new ControlPlaneDeviceAuthorizer({
    baseUrl: "http://control",
    fetch: async (input, init) => {
      if (!available) return new Response(null, { status: 503 });
      // Real bearer verification and durable device projection; only HTTP transport is in-process.
      const response = await control.app.request(String(input), init);
      didAuthorize();
      return response;
    },
  });
  const dispatch = vi.fn(async () => ({ op: "list" as const, schemaVersion: 1 as const, conversations: [] }));
  const downloadFile = vi.fn(async () => new Response("private file"));
  const handler = createOperatorConversationRelayHandler({
    authorizeDevice: authorizer,
    dispatch,
    downloadFile,
  });
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing relay port");
  const base = `http://127.0.0.1:${address.port}`;
  return {
    dispatch,
    downloadFile,
    sleep() {
      available = false;
    },
    async revokeWhileOffline() {
      // Model an owner revocation persisted while the relay cannot reach control.
      // This is a local lifecycle fixture, not a fleet/offline revocation delivery service.
      const response = await control.app.request(`/v1/devices/${redeemed.deviceId}/revoke`, {
        method: "POST",
        headers: owner,
      });
      expect(response.status).toBe(200);
    },
    async wake() {
      control.close();
      control = await boot();
      available = true;
    },
    post(bearer = token) {
      return fetch(`${base}/operator/v1/dispatch`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify(list),
      });
    },
    async pausedRequest(path: string, body: unknown) {
      authorized = new Promise<void>((resolve) => {
        didAuthorize = resolve;
      });
      const request = httpRequest(`${base}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
      const result = new Promise<{ status: number; body: string }>((resolve, reject) => {
        request.on("error", reject);
        request.on("response", async (response) => {
          const chunks: Buffer[] = [];
          for await (const chunk of response) chunks.push(Buffer.from(chunk));
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        });
      });
      const text = JSON.stringify(body);
      request.write(text.slice(0, 1));
      await authorized;
      return {
        finish() {
          request.end(text.slice(1));
          return result;
        },
      };
    },
  };
}

describe("relay authority across sleep and wake", () => {
  for (const [path, body] of [
    ["/operator/v1/dispatch", list],
    [OPERATOR_DELIVERED_FILE_DOWNLOAD_PATH, download],
  ] as const) {
    it(`refuses a revoked-while-asleep device's in-flight ${path} after wake`, async () => {
      const host = await fixture();
      const pending = await host.pausedRequest(path, body);
      host.sleep();
      await host.revokeWhileOffline();
      await host.wake();
      const response = await pending.finish();
      expect(response.status).toBe(401);
      expect(JSON.parse(response.body)).toEqual({ error: "revoked" });
      expect(host.dispatch).not.toHaveBeenCalled();
      expect(host.downloadFile).not.toHaveBeenCalled();
      expect((await host.post()).status).toBe(401);
    });
  }

  it("fails closed until control returns and reconnects a valid device with its ordinary bearer after wake", async () => {
    const host = await fixture();
    expect((await host.post()).status).toBe(200);
    host.dispatch.mockClear();
    host.sleep();
    expect((await host.post()).status).toBe(503);
    expect(host.dispatch).not.toHaveBeenCalled();
    await host.wake();
    expect((await host.post("wrong-bearer")).status).toBe(401);
    expect(host.dispatch).not.toHaveBeenCalled();
    const response = await host.post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...list, conversations: [] });
    expect(host.dispatch).toHaveBeenCalledTimes(1);
  });

  it("refuses an already-admitted request if control is still unavailable", async () => {
    const host = await fixture();
    const pending = await host.pausedRequest("/operator/v1/dispatch", list);
    host.sleep();
    expect((await pending.finish()).status).toBe(503);
    expect(host.dispatch).not.toHaveBeenCalled();
  });
});
