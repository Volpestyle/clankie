import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import { createClankieApp, type TrustedOperatorIdentity } from "../src/app.ts";
import { ConnectorDetection } from "../src/app/connector-detection.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { CONNECTOR_DETECTION_PATH } from "@clankie/protocol/connector";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function operator(request: Request): Promise<TrustedOperatorIdentity | undefined> {
  return Promise.resolve(
    request.headers.get("authorization") === "Bearer operator-secret"
      ? { operatorId: "operator-james" }
      : undefined,
  );
}

async function app(): Promise<{ app: Hono; detection: ConnectorDetection; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "connector-detection-"));
  roots.push(root);
  const path = join(root, "connector-detection.json");
  const detection = new ConnectorDetection(path);
  const service = await createClankieApp({
    captain: createStubCaptain(),
    authenticateOperator: operator,
    connectorDetection: detection,
  });
  return { app: service.app, detection, path };
}

const authed = (method: "GET" | "POST", body?: unknown) => ({
  method,
  headers: {
    authorization: "Bearer operator-secret",
    ...(body === undefined ? {} : { "content-type": "application/json" }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

it("toggles Herdr detection and refuses an unknown app, and the file is the same store", async () => {
  const service = await app();
  const listed = await service.app.request(CONNECTOR_DETECTION_PATH, authed("GET"));
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({
    multiplexers: [{ id: "herdr", enabled: true }],
    apps: [],
  });

  const off = await service.app.request(
    CONNECTOR_DETECTION_PATH,
    authed("POST", { multiplexer: "herdr", enabled: false }),
  );
  expect(off.status).toBe(200);
  expect(await off.json()).toMatchObject({ multiplexers: [{ id: "herdr", enabled: false }] });
  expect(service.detection.multiplexer("herdr")).toBe(false);
  expect(new ConnectorDetection(service.path).multiplexer("herdr")).toBe(false);
  const saved = JSON.parse(await readFile(service.path, "utf8")) as {
    multiplexers: Record<string, boolean>;
  };
  expect(saved.multiplexers.herdr).toBe(false);

  const unknown = await service.app.request(
    CONNECTOR_DETECTION_PATH,
    authed("POST", { deviceId: "missing-app", served: false }),
  );
  expect(unknown.status).toBe(404);
  const malformed = await service.app.request(
    CONNECTOR_DETECTION_PATH,
    authed("POST", { multiplexer: "tmux", enabled: true }),
  );
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({ error: "unknown_multiplexer" });
  const badId = await service.app.request(
    CONNECTOR_DETECTION_PATH,
    authed("POST", { multiplexer: "Herdr", enabled: true }),
  );
  expect(badId.status).toBe(400);
  expect(await badId.json()).toEqual({ error: "malformed" });

  await writeFile(
    service.path,
    `${JSON.stringify({
      schemaVersion: 1,
      multiplexers: { herdr: false, someday: true },
      unserved: [],
    })}\n`,
  );
  const reloaded = new ConnectorDetection(service.path);
  expect(reloaded.multiplexers()).toEqual([{ id: "herdr", enabled: false }]);
  expect(reloaded.setMultiplexer("herdr", true)).toBe(true);
  const kept = JSON.parse(await readFile(service.path, "utf8")) as {
    multiplexers: Record<string, boolean>;
  };
  expect(kept.multiplexers).toEqual({ herdr: true, someday: true });

  const anonymous = await service.app.request(CONNECTOR_DETECTION_PATH);
  expect(anonymous.status).toBe(401);
});
