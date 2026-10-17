import { serve } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { HTTP_SETTINGS_PATH, HttpSettingsSchema } from "../../../packages/protocol/src/owner-settings.ts";
import { SettingsStore } from "../../../packages/settings/src/index.ts";
import { createClankieApp } from "../../clankie/src/app.ts";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";
import { deviceDoorwayFetch } from "../../clankie/src/device-doorway.ts";
import { runHttpCommand } from "../../tui/src/command/http.ts";
import { ControlPlaneDeviceAuthorizer } from "../src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../src/operator-conversations.ts";

const APP = "http://localhost:8086";
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function address(server: Server | ReturnType<typeof serve>) {
  if (!server.listening) await once(server, "listening");
  cleanups.push(async () => {
    const closed = once(server, "close");
    server.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
    await closed;
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw Error("No fixture address");
  return `http://127.0.0.1:${addr.port}`;
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "browser-cors-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const settings = new SettingsStore(join(root, "settings.json"));
  const core = await createClankieApp({
    captain: createStubCaptain(),
    settings,
    deviceSessionKey: randomBytes(32),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-owner"
        ? { operatorId: "fixture-owner" }
        : undefined,
  });
  cleanups.push(async () => core.close());
  const base = await address(
    serve({ hostname: "127.0.0.1", port: 0, fetch: (r: Request) => core.app.fetch(r) }),
  );
  const doorway = await address(
    serve({ hostname: "127.0.0.1", port: 0, fetch: deviceDoorwayFetch((r: Request) => core.app.fetch(r)) }),
  );
  const handler = createOperatorConversationRelayHandler({
    httpSettings: async () => (await settings.load()).http,
    authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl: base }),
    dispatch: async () => {
      throw Error("CORS/settings must not dispatch a conversation");
    },
    roomRequest: (path, method, token, body) =>
      fetch(new URL(path, base), {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body }),
      }),
  });
  const relayServer = createServer((request, response) => {
    void handler(request, response)
      .then((handled) => {
        if (!handled) {
          response.statusCode = 404;
          response.end();
        }
      })
      .catch(() => {
        response.statusCode = 500;
        response.end();
      });
  });
  relayServer.listen(0, "127.0.0.1");
  const relay = await address(relayServer);
  const ownerFetcher = {
    fetch: (path: string, init?: RequestInit) =>
      fetch(new URL(path, base), {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: "Bearer fixture-owner" },
      }),
  };
  return { settings, base, doorway, relay, ownerFetcher };
}
const json = (origin?: string, token?: string) => ({
  "content-type": "application/json",
  ...(origin === undefined ? {} : { origin }),
  ...(token ? { authorization: `Bearer ${token}` } : {}),
});
const preflight = (origin: string, method = "POST", headers = "authorization, content-type") => ({
  method: "OPTIONS",
  headers: { origin, "access-control-request-method": method, "access-control-request-headers": headers },
});

it("configures exact origins through the owner CLI/API and enforces core/relay preflights without authentication", async () => {
  const f = await fixture();
  expect((await f.settings.load()).http.allowedOrigins).toEqual([]);
  expect((await fetch(f.base + HTTP_SETTINGS_PATH, preflight(APP))).status).toBe(403);
  await runHttpCommand(["allow-origins", APP], { ownerFetcher: f.ownerFetcher });
  expect((await new SettingsStore(f.settings.path).load()).http.allowedOrigins).toEqual([APP]);
  for (const base of [f.base, f.relay]) {
    const ok = await fetch(base + HTTP_SETTINGS_PATH, preflight(APP, "GET", "Authorization, Content-Type"));
    expect(ok.status).toBe(204);
    expect(await ok.text()).toBe("");
    expect(ok.headers.get("access-control-allow-origin")).toBe(APP);
    expect(ok.headers.get("access-control-allow-credentials")).toBeNull();
    expect(ok.headers.get("access-control-allow-methods")).toBe("GET");
    expect(ok.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
    expect(ok.headers.get("vary")).toContain("Access-Control-Request-Headers");
    for (const origin of ["null", "http://localhost:8087", "https://localhost:8086", APP + ".evil.test"]) {
      const denied = await fetch(base + HTTP_SETTINGS_PATH, preflight(origin));
      expect(denied.status).toBe(403);
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
      expect(denied.headers.get("vary")).toContain("Origin");
    }
    for (const init of [
      preflight(APP, "TRACE"),
      preflight(APP, "POST", "x-untrusted"),
      { method: "OPTIONS", headers: { origin: APP } },
    ]) {
      const invalid = await fetch(base + HTTP_SETTINGS_PATH, init);
      expect(invalid.status).toBe(400);
      expect(invalid.headers.get("access-control-allow-origin")).toBeNull();
    }
    const unauthenticated = await fetch(base + HTTP_SETTINGS_PATH, { headers: { origin: APP } });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("access-control-allow-origin")).toBe(APP);
  }
  for (const origin of [
    "*",
    "https://*.example.test",
    "null",
    "https://example.test/path",
    "https://user:pass@example.test",
    "https://example.test/",
    "file://example.test",
  ]) {
    expect(HttpSettingsSchema.safeParse({ allowedOrigins: [origin] }).success).toBe(false);
  }
  const current = await runHttpCommand(["show"], { ownerFetcher: f.ownerFetcher });
  const invalid = await f.ownerFetcher.fetch(HTTP_SETTINGS_PATH, {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ schemaVersion: 1, expectedRevision: current.revision, allowedOrigins: ["*"] }),
  });
  expect(invalid.status).toBe(400);
  expect((await f.settings.load()).http.allowedOrigins).toEqual([APP]);
  const conflict = await f.ownerFetcher.fetch(HTTP_SETTINGS_PATH, {
    method: "POST",
    headers: json(),
    body: JSON.stringify({ schemaVersion: 1, expectedRevision: "0".repeat(64), allowedOrigins: [] }),
  });
  expect(conflict.status).toBe(409);
  await runHttpCommand(["allow-origins"], { ownerFetcher: f.ownerFetcher });
  for (const base of [f.base, f.relay])
    expect((await fetch(base + HTTP_SETTINGS_PATH, preflight(APP))).status).toBe(403);
});

it("preserves single-use pairing and signed device authority across allowed and refused browser requests", async () => {
  const f = await fixture();
  await runHttpCommand(["allow-origins", APP], { ownerFetcher: f.ownerFetcher });
  expect(
    (await fetch(f.base + "/v1/pairing/offer", { method: "POST", headers: json(APP), body: "{}" })).status,
  ).toBe(401);
  const offer = await (
    await f.ownerFetcher.fetch("/v1/pairing/offer", { method: "POST", headers: json(), body: "{}" })
  ).json();
  const body = JSON.stringify({ code: offer.code, device: { name: "CORS browser", platform: "unknown" } });
  const refused = await fetch(f.doorway + "/v1/pairing/redeem", {
    method: "POST",
    headers: json("https://evil.test"),
    body,
  });
  expect(refused.status).toBe(403);
  expect(refused.headers.get("access-control-allow-origin")).toBeNull();
  expect((await fetch(f.doorway + "/v1/pairing/redeem", preflight(APP))).status).toBe(204);
  const redeemed = await fetch(f.doorway + "/v1/pairing/redeem", {
    method: "POST",
    headers: json(APP),
    body,
  });
  expect(redeemed.status).toBe(200);
  expect(redeemed.headers.get("access-control-allow-origin")).toBe(APP);
  const pending = await redeemed.json();
  expect(
    (await fetch(f.doorway + "/v1/pairing/redeem", { method: "POST", headers: json(APP), body })).status,
  ).toBe(409);
  const completed = await fetch(f.doorway + "/v1/pairing/complete", {
    method: "POST",
    headers: json(APP),
    body: JSON.stringify({ completionToken: pending.completionToken, acceptedGrants: pending.offeredGrants }),
  });
  expect(completed.status).toBe(200);
  const session = await completed.json();
  const self = await fetch(f.doorway + "/v1/devices/self", { headers: json(APP, session.deviceToken) });
  expect(self.status).toBe(200);
  for (const token of ["invalid", session.deviceToken]) {
    const result = await fetch(f.relay + HTTP_SETTINGS_PATH, { headers: json(APP, token) });
    expect(result.status).toBe(token === "invalid" ? 401 : 200);
    expect(result.headers.get("access-control-allow-origin")).toBe(APP);
  }
  const refusedRelay = await fetch(f.relay + HTTP_SETTINGS_PATH, {
    headers: json("https://evil.test", session.deviceToken),
  });
  expect(refusedRelay.status).toBe(403);
  expect(refusedRelay.headers.get("access-control-allow-origin")).toBeNull();
  expect((await fetch(f.doorway + HTTP_SETTINGS_PATH, preflight(APP, "GET"))).status).toBe(404);
  const native = await f.ownerFetcher.fetch(HTTP_SETTINGS_PATH);
  expect(native.status).toBe(200);
  expect(native.headers.get("access-control-allow-origin")).toBeNull();
});

it("fails closed for browser requests when the saved allowlist cannot be read", async () => {
  const f = await fixture();
  await writeFile(f.settings.path, "{corrupt fixture settings");
  for (const base of [f.base, f.relay]) {
    const response = await fetch(base + HTTP_SETTINGS_PATH, preflight(APP));
    expect(response.status).toBe(503);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  }
});
