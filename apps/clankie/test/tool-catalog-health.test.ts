import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import { fleetLinkFetch } from "../src/fleet-link.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { describe, expect, it, vi } from "vitest";
import { RemoteObservationError } from "../src/remote-fleet-relay.ts";
import {
  FleetSeatToolCatalogSchema,
  FleetToolCatalogHealthPageSchema,
  fleetSeatToolCatalogPath,
  FLEET_TOOL_CATALOG_HEALTH_PATH,
} from "@clankie/protocol/tool-catalog";
import { ToolCatalogHealthStore, type ToolCatalogIdentity } from "../src/captain/tool-catalog-health.ts";

// The real worker bridge names. A rejected server gives Claude none of these;
// the tools/list incident in VUH-1651 dropped the whole Clankie server.
const workerTools = ["message_clankie", "clankie_tools", "clankie_call", "list_fleet_seats", "message_peer"];
const identity: ToolCatalogIdentity = {
  paneId: "w3Z:p2N",
  occupantId: "native-claude-session",
  harness: "claude",
  sessionId: "native-session",
  bridge: "worker",
};
const report = (tools: string[], extra: Record<string, unknown> = {}) =>
  FleetSeatToolCatalogSchema.parse(
    JSON.parse(
      JSON.stringify({
        schemaVersion: 1,
        harness: "claude",
        sessionId: "native-session",
        bridge: "worker",
        tools,
        checkedAt: "2026-10-04T18:00:00.000Z",
        ...extra,
      }),
    ),
  );

// These checks cross native-report decoding, identity-bound storage and the
// public doctor contract; no MCP/client readiness is inferred from a bridge list.
describe("native catalog report boundary", () => {
  it("publishes every missing bridge tool after whole-server rejection", () => {
    const store = new ToolCatalogHealthStore();
    const health = store.record(identity, report([]), workerTools);
    const page = FleetToolCatalogHealthPageSchema.parse({
      schemaVersion: 1,
      seats: [{ paneId: identity.paneId, seatId: "terminal-claude", toolCatalog: health }],
    });
    expect(page.seats[0]?.toolCatalog).toMatchObject({ status: "mismatch", missing: workerTools });
    expect(health.detail).toContain("message_clankie");
    expect(health.remediation).toContain("/reload-plugins");
  });

  it("does not carry a successful native check into the next pane occupant", () => {
    const store = new ToolCatalogHealthStore();
    expect(store.record(identity, report(workerTools), workerTools).status).toBe("matched");
    expect(
      store.read({ ...identity, occupantId: "new-native-occupant", sessionId: "new-session" }).status,
    ).toBe("unverified");
    expect(store.read({ ...identity, harness: "codex" }).status).toBe("unverified");
    expect(store.read({ ...identity, bridge: "operator" }).status).toBe("unverified");
  });

  it("retains the failing operator bridge after a later successful worker check", () => {
    const store = new ToolCatalogHealthStore();
    const operator = { ...identity, bridge: "operator" as const };
    store.record(operator, report([], { bridge: "operator" }), [
      "hire_agent",
      "reply",
      "reconcile_seat_call",
    ]);
    store.record(identity, report(workerTools), workerTools);
    expect(store.readPane(identity)).toMatchObject({
      status: "mismatch",
      bridge: "operator",
      missing: ["hire_agent", "reply", "reconcile_seat_call"],
    });
    expect(store.readPane({ ...identity, sessionId: "replacement" }).status).toBe("unverified");
  });

  it("marks obsolete accepted tools as a mismatch and bounds whole-catalog diagnostics", () => {
    const store = new ToolCatalogHealthStore();
    store.record(identity, report(workerTools), workerTools);
    expect(store.read(identity, ["message_clankie"])).toMatchObject({ status: "mismatch", missing: [] });
    expect(store.read(identity, ["message_clankie"]).detail).toContain("No longer served: clankie_tools");
    const fullBank = Array.from({ length: 32 }, (_, index) => `${index}_${"tool".repeat(60)}`);
    const health = store.record(identity, report([]), fullBank);
    expect(health.detail.length).toBeLessThanOrEqual(4096);
    expect(
      FleetToolCatalogHealthPageSchema.parse({
        schemaVersion: 1,
        seats: [{ paneId: identity.paneId, seatId: "terminal-claude", toolCatalog: health }],
      }).seats[0]?.toolCatalog.missing,
    ).toEqual(fullBank);
  });

  it("compares to the current bank and never calls unavailable native evidence matched", () => {
    const store = new ToolCatalogHealthStore();
    store.record(identity, report(["message_clankie"]), ["message_clankie"]);
    expect(store.read(identity, workerTools)).toMatchObject({
      status: "mismatch",
      missing: workerTools.slice(1),
    });
    expect(
      store.record(
        identity,
        report([], { error: "Native thread introspection is unavailable" }),
        workerTools,
      ),
    ).toMatchObject({
      status: "unverified",
      missing: [],
      detail: "Native thread introspection is unavailable",
    });
  });
});

it("remote report transport failures return safe 503 reasons at either proof without recording evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-remote-catalog-error-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const captain = createCaptain({ herdrAvailable: () => false } as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    settings,
  });
  const recorded = vi.spyOn(captain, "recordSeatToolCatalog");
  let calls = 0;
  let failAt = 1;
  let unavailable = false;
  // Explicit native-identity surrogate: real HTTP routing/schema/captain, with
  // transport failure injection instead of a Windows harness in this test.
  const service = await createClankieApp({
    captain,
    settings,
    fleetLinks: {
      authenticate: () => undefined,
      identity: () => ({
        fleet: "pc",
        pane: identity.paneId,
        current: () => true,
        validate: async () => true,
        projectProof: async () => {
          calls += 1;
          if (calls === failAt) throw new RemoteObservationError("remote_observation_timeout");
          if (unavailable) return undefined;
          return {
            fleet: "pc",
            pane: identity.paneId,
            nativeOccupantId: identity.occupantId,
            binding: { socketPath: "native-fixture" },
            shell: { pid: 1, startTime: "native-fixture" },
            processes: [{ pid: 2, startTime: "native-fixture" }],
          };
        },
      }),
    },
  });
  const server = serve({ fetch: fleetLinkFetch(service.app.fetch), hostname: "127.0.0.1", port: 0 });
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    const post = (pane = identity.paneId) =>
      fetch(`http://127.0.0.1:${port}` + fleetSeatToolCatalogPath(pane), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(report(workerTools)),
        signal: AbortSignal.timeout(5_000),
      });
    for (failAt of [1, 2]) {
      calls = 0;
      const response = await post();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "remote_observation_timeout" });
      expect(calls).toBe(failAt);
      expect(recorded).not.toHaveBeenCalled();
    }
    calls = 0;
    const wrongPane = await post("w1:p1");
    expect(wrongPane.status).toBe(403);
    expect(calls).toBe(0);
    failAt = 0;
    unavailable = true;
    const noProof = await post();
    expect(noProof.status).toBe(403);
    expect(await noProof.json()).toEqual({ error: "remote_pane_required" });
    expect(recorded).not.toHaveBeenCalled();
    expect((await captain.toolCatalogHealth()).seats).toEqual([]);
  } finally {
    recorded.mockRestore();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    service.close();
    await captain.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("admits catalog reports through real local and remote listeners while keeping health and native identity protected", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-catalog-http-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const operatorToken = randomBytes(24).toString("hex");
  // No harness is installed in this test host: the actual captain refuses to
  // turn a client-supplied native session ID into accepted evidence.
  const captain = createCaptain({ herdrAvailable: () => false } as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    settings,
  });
  const link = new LocalFleetLink({
    directory: join(root, "links"),
    binding: async () => undefined,
    prove: async (socket, pane) => socket.remoteAddress === "127.0.0.1" && pane === identity.paneId,
  });
  const service = await createClankieApp({
    captain,
    settings,
    localFleet: link,
    authenticateOperator: createCredentialBackedOperatorAuthenticator({
      env: { CLANKIE_OPERATOR_TOKEN: operatorToken },
      store: new FileCredentialStore(join(root, "credentials.json")),
      identity: { operatorId: "test-owner" },
    }),
  });
  const servers = [
    serve({ fetch: link.fetch(service.app.fetch), hostname: "127.0.0.1", port: 0 }),
    serve({ fetch: fleetLinkFetch(service.app.fetch), hostname: "127.0.0.1", port: 0 }),
    serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 }),
  ];
  try {
    const urls = await Promise.all(
      servers.map(async (server) => {
        await new Promise<void>((resolve, reject) => {
          server.once("listening", resolve);
          server.once("error", reject);
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("No test listener address");
        return `http://127.0.0.1:${address.port}`;
      }),
    );
    const post = (url: string, body: unknown, pane = identity.paneId) =>
      fetch(url + fleetSeatToolCatalogPath(pane), {
        method: "POST",
        headers: {
          "x-clankie-pane": identity.paneId,
          authorization: `Bearer ${operatorToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    // A 400 demonstrates each link whitelist forwarded into the real schema
    // parser; the former omissions returned 404 before reaching that parser.
    expect((await post(urls[0]!, {})).status).toBe(400);
    expect((await post(urls[1]!, {})).status).toBe(400);
    expect((await post(urls[0]!, report(workerTools), "another-pane")).status).toBe(403);
    const unsupported = await post(urls[0]!, report(workerTools));
    expect(unsupported.status).toBe(403);
    expect(await unsupported.json()).toEqual({ error: "native_session_required" });
    const forgedNativeId = await post(urls[2]!, report(workerTools));
    expect(forgedNativeId.status).toBe(403);
    expect(await forgedNativeId.json()).toEqual({ error: "native_session_required" });
    for (const url of urls.slice(0, 2)) {
      expect(
        (
          await fetch(url + FLEET_TOOL_CATALOG_HEALTH_PATH, {
            headers: { authorization: `Bearer ${operatorToken}` },
            signal: AbortSignal.timeout(5_000),
          })
        ).status,
      ).toBe(404);
    }
    expect(
      (
        await fetch(urls[2]! + FLEET_TOOL_CATALOG_HEALTH_PATH, {
          signal: AbortSignal.timeout(5_000),
        })
      ).status,
    ).toBe(401);
    const doctor = await fetch(urls[2]! + FLEET_TOOL_CATALOG_HEALTH_PATH, {
      headers: { authorization: `Bearer ${operatorToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    expect(doctor.status).toBe(200);
    expect(FleetToolCatalogHealthPageSchema.parse(await doctor.json())).toEqual({
      schemaVersion: 1,
      seats: [],
    });
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
            if ("closeAllConnections" in server) server.closeAllConnections();
          }),
      ),
    );
    service.close();
    await link.close();
    await captain.close();
    await rm(root, { recursive: true, force: true });
  }
});
