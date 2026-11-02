import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, expect, it, vi } from "vitest";
import {
  FLEET_LEADS_PATH,
  FleetLeadsSnapshotSchema,
  TAKE_CONTROL_GRANTS,
  OPERATOR_CONVERSATION_DISPATCH_PATH,
} from "@clankie/protocol";
import { hostedOperatorAllows } from "@clankie/protocol/hosted-operator";
import { createClankieApp } from "../src/app.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { TurnMetrics, TurnSettledLog, turnSettledLogPath } from "../src/captain/turn-metrics.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { runHeadlessCaptainCommand } from "../../tui/bin/headless-captain.ts";
import { runFleetLeadsCommand } from "../../tui/src/command/fleet-leads.ts";
import { leadChatFixture } from "./fixtures/lead-chats.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

it("reads real host lead and device facts over HTTP, including the relay's throttled connector activity", async () => {
  const f = await leadChatFixture(false, cleanup);
  let now = Date.now();
  const iso = (offset = 0) => new Date(now + offset).toISOString();
  const key = randomBytes(32);
  const signer = new DeviceSessionSigner(key);
  const events: unknown[] = [];
  for (const id of ["recent", "old", "unseen", "revoked", "expired", "ordinary"]) {
    const event = (type: string, data: object, at = iso(-60 * 60_000)) => ({
      id: randomUUID(),
      type,
      occurredAt: at,
      missionId: `device:${id}`,
      correlationId: "fleet-leads-proof",
      profileHash: "fixture",
      data: { schemaVersion: 1, deviceId: id, ...data },
    });
    events.push(
      event("device.pairing.redeemed", {
        offerId: id,
        name: id === "recent" ? "Claude" : id,
        platform: "unknown",
        offeredGrants: TAKE_CONTROL_GRANTS,
        mintedBy: "local-operator",
        pendingExpiresAt: iso(60_000),
        ...(id === "ordinary" ? {} : { scope: "connector" }),
        ...(id === "expired" ? { run: { runId: "expired-proof", purpose: "test", expiresAt: iso(-1) } } : {}),
      }),
    );
    events.push(
      event("device.activated", { grants: TAKE_CONTROL_GRANTS, sessionExpiresAt: iso(60 * 60_000) }),
    );
    if (id !== "unseen")
      events.push(event("device.seen", {}, iso(id === "old" ? -16 * 60_000 : -2 * 60_000)));
    if (id === "revoked") events.push(event("device.revoked", { revokedBy: "local-operator" }));
  }
  const eventLogPath = join(f.root, "leads-devices.jsonl");
  await writeFile(eventLogPath, events.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const service = await createClankieApp({
    captain: f.captain,
    deviceSessionKey: key,
    eventLogPath,
    clock: () => new Date(now),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  cleanup.push(async () => service.close());
  const server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  cleanup.push(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const read = async (bearer = "owner") =>
    fetch(`${baseUrl}${FLEET_LEADS_PATH}`, { headers: { authorization: `Bearer ${bearer}` } });
  const snapshot = async () => {
    const response = await read();
    expect(response.status).toBe(200);
    return FleetLeadsSnapshotSchema.parse(await response.json());
  };
  const initial = await snapshot();
  expect(initial.leads.map((lead) => [lead.id, lead.active])).toEqual([
    ["clankie", true],
    ["old", false],
    ["recent", true],
    ["unseen", false],
  ]);
  expect(initial.leads.find((lead) => lead.id === "recent")).toMatchObject({ name: "Claude", kind: "app" });
  expect(hostedOperatorAllows("GET", FLEET_LEADS_PATH)).toBe(true);
  expect(hostedOperatorAllows("POST", FLEET_LEADS_PATH)).toBe(false);
  const token = (id: string) =>
    signer.issue(
      mintDeviceSessionClaims({ deviceId: id, nowEpochSeconds: Math.floor(now / 1000), ttlSeconds: 3600 }),
    );
  expect((await read(token("recent"))).status).toBe(403);
  expect((await read("unknown")).status).toBe(403);
  expect((await read(token("ordinary"))).status).toBe(200);
  const cli = await runFleetLeadsCommand(["--json"], {
    host: baseUrl,
    env: { CLANKIE_OPERATOR_TOKEN: "owner" },
  });
  expect(cli.leads).toEqual(initial.leads);
  for (const args of [
    ["fleet", "leads"],
    ["fleet", "leads", "--json"],
  ]) {
    let output = "";
    const code = await runHeadlessCaptainCommand(args, {
      repoRoot: f.root,
      host: baseUrl,
      env: { CLANKIE_OPERATOR_TOKEN: "owner" },
      stdout: {
        write: (chunk) => {
          output += chunk;
        },
      },
    });
    expect(code).toBe(0);
    if (args.includes("--json"))
      expect(FleetLeadsSnapshotSchema.parse(JSON.parse(output)).leads).toEqual(initial.leads);
    else expect(output).toContain("recent\tClaude\tactive");
  }

  const relayAuth = new ControlPlaneDeviceAuthorizer({ baseUrl });
  expect((await relayAuth.authorize(token("old"))).authorized).toBe(true);
  let refreshed = (await snapshot()).leads.find((lead) => lead.id === "old")!;
  expect(refreshed).toMatchObject({ active: true, lastActiveAt: iso() });
  const firstSeen = refreshed.lastActiveAt;
  now += 59_999;
  expect((await relayAuth.authorize(token("old"))).authorized).toBe(true);
  expect((await snapshot()).leads.find((lead) => lead.id === "old")!.lastActiveAt).toBe(firstSeen);
  now += 1;
  expect((await relayAuth.authorize(token("old"))).authorized).toBe(true);
  expect((await snapshot()).leads.find((lead) => lead.id === "old")!.lastActiveAt).toBe(iso());
  const seenEvents = (await readFile(eventLogPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((row) => row.type === "device.seen" && row.data.deviceId === "old");
  expect(seenEvents).toHaveLength(3); // one replayed, two real relay auth checks
  const setLead = async (lead: "apps" | "clankie") => {
    const response = await fetch(`${baseUrl}${OPERATOR_CONVERSATION_DISPATCH_PATH}`, {
      method: "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      body: JSON.stringify({ op: "lead", schemaVersion: 1, command: { action: "set", lead } }),
    });
    expect(response.status).toBe(200);
  };
  await setLead("apps");
  expect((await snapshot()).leads[0]!.active).toBe(false);
  const metrics = new TurnMetrics({
    conversationId: "proof",
    lane: "operator",
    runId: "proof",
    acceptedAt: iso(-1000),
  });
  new TurnSettledLog(turnSettledLogPath(f.root)).append(metrics.finish("completed", new Date(now)));
  expect((await snapshot()).leads[0]).toMatchObject({ active: true, lastActiveAt: iso() });
  now += 10 * 60_000;
  expect((await snapshot()).leads[0]!.active).toBe(false);
  await setLead("clankie");
  expect((await snapshot()).leads[0]!.active).toBe(true);
  now += 15 * 60_000;
  expect((await snapshot()).leads.find((lead) => lead.id === "old")!.active).toBe(false);
});
