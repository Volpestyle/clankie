import { runMachinesCommand } from "../../tui/src/command/machines.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { FileCredentialStore } from "@clankie/credential-broker";
import { MachineJoins } from "../src/machine-joins.ts";
import { machineJoinHash } from "../src/machine-join-crypto.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { TAKE_CONTROL_GRANTS, SUPERVISE_GRANTS, MachineSchema } from "@clankie/protocol";
import { DESKTOP_ACCESS_PATH, DesktopAccessSnapshotSchema } from "@clankie/protocol/desktop-access";
import { hostedOperatorAllows } from "@clankie/protocol/hosted-operator";
import { publicGatewayTargetFor } from "@clankie/protocol/public-gateway";
import { createClankieApp } from "../src/app.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { ExecutionConnections } from "../src/herdr-session.ts";
import { runComputerCommand } from "../../tui/src/command/computer.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(withAccountRecords = false) {
  const root = await mkdtemp(join(tmpdir(), "desktop-access-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    machines: [{ id: "pc", ssh: "unused.invalid", shell: "posix", aliases: [] }],
    machineAccess: { pc: "workers" },
  }));
  const runtimes = new ExecutionConnections({
    settings,
    primary: { binding: () => undefined, status: () => "disabled" },
    run: async () => ({ stdout: '{"sessions":[]}' }),
    env: { ...process.env, PATH: "/not-installed" },
  });
  const joins = new MachineJoins({
    settings,
    secrets: new FileCredentialStore(join(root, "join-credentials.json")),
    directory: join(root, "joins"),
  });
  runtimes.machines.setJoinedProvider(joins);
  let now = Date.now();
  if (withAccountRecords) {
    const records = [
      { deviceId: "account", mintedBy: "hosted-account" },
      { deviceId: "account-child", mintedBy: "device:account" },
      { deviceId: "account-grandchild", mintedBy: "device:account-child" },
    ].flatMap(({ deviceId, mintedBy }) => {
      const event = (type: string, data: object) => ({
        id: randomUUID(),
        type,
        occurredAt: new Date(now).toISOString(),
        missionId: `device:${deviceId}`,
        correlationId: "desktop-owner-device",
        profileHash: "fixture",
        data: { schemaVersion: 1, deviceId, ...data },
      });
      return [
        event("device.pairing.redeemed", {
          offerId: deviceId,
          name: deviceId,
          platform: "macos",
          mintedBy,
          offeredGrants: TAKE_CONTROL_GRANTS,
          pendingExpiresAt: new Date(now + 60000).toISOString(),
        }),
        event("device.activated", {
          grants: TAKE_CONTROL_GRANTS,
          sessionExpiresAt: new Date(now + 3600000).toISOString(),
        }),
      ];
    });
    await writeFile(
      join(root, "events.jsonl"),
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
  }
  let authorized = true;
  let authCalls = 0;
  let revokeAt = Infinity;
  let service: Awaited<ReturnType<typeof createClankieApp>>;
  const boot = () =>
    createClankieApp({
      captain: createStubCaptain(),
      settings,
      runtimes,
      eventLogPath: join(root, "events.jsonl"),
      deviceSessionKey: new Uint8Array(32).fill(19),
      clock: () => new Date(now),
      isSameMacRequest: (request) => new URL(request.url).hostname === "127.0.0.1",
      authenticateOperator: async (request) =>
        authorized && ++authCalls < revokeAt && request.headers.get("authorization") === "Bearer owner"
          ? { operatorId: "owner" }
          : undefined,
      authenticateCaptain: async (request) =>
        request.headers.get("authorization") === "Bearer captain" ? { captainId: "captain" } : undefined,
    });
  service = await boot();
  cleanups.push(async () => {
    service.close();
  });
  const server = serve({ fetch: (request) => service.app.fetch(request), hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        if ("closeAllConnections" in server) server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No owned listener");
  const host = `http://127.0.0.1:${address.port}`;
  const request = (path = DESKTOP_ACCESS_PATH, body?: unknown, bearer = "owner") =>
    fetch(host + path, {
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    });
  const pair = async (grants: typeof TAKE_CONTROL_GRANTS, parent = "owner") => {
    const offer = await (await request("/v1/pairing/offer", {}, parent)).json();
    const pending = await (
      await request(
        "/v1/pairing/redeem",
        { code: offer.code, device: { name: "Fixture owner", platform: "macos" } },
        "",
      )
    ).json();
    return (
      await (
        await request(
          "/v1/pairing/complete",
          { completionToken: pending.completionToken, acceptedGrants: grants },
          "",
        )
      ).json()
    ).deviceToken as string;
  };
  const cli = (...args: string[]) =>
    runComputerCommand(args, { host, env: { CLANKIE_OPERATOR_TOKEN: "owner" } });
  const state = async (query = "") =>
    DesktopAccessSnapshotSchema.parse(await (await request(DESKTOP_ACCESS_PATH + query)).json());
  return {
    settings,
    joins,
    pair,
    token: (deviceId: string) =>
      new DeviceSessionSigner(new Uint8Array(32).fill(19)).issue(
        mintDeviceSessionClaims({ deviceId, nowEpochSeconds: Math.floor(now / 1000), ttlSeconds: 3600 }),
      ),
    request,
    cli,
    machineCli: () =>
      runMachinesCommand(["list", "--desktop", "--json"], { host, env: { CLANKIE_OPERATOR_TOKEN: "owner" } }),
    state,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    revoke: () => {
      authorized = false;
    },
    revokeAtCommit: () => {
      authCalls = 0;
      revokeAt = 2;
    },
    restart: async () => {
      service.close();
      service = await boot();
    },
  };
}

it("real service and CLI share defaults, persistent per-machine/lead choices, revisions and unchanged ceilings", async () => {
  const f = await fixture();
  const first = await f.state();
  expect(await f.state("?lead=constructor")).toMatchObject({ selectedMode: "none" });
  expect(first).toMatchObject({
    desktopMode: "none",
    effectiveMode: "none",
    permissions: { state: "unavailable", reason: "not_checked" },
    vm: { state: "unavailable" },
  });
  expect(await f.cli("mode", "host", "--json")).toMatchObject({ desktopMode: "host", effectiveMode: "host" });
  await expect(f.cli("mode", "screen", "--expected-revision", first.revision)).rejects.toThrow(
    "Settings changed",
  );
  await f.cli("mode", "vm", "--lead", "duet");
  expect(await f.state("?lead=duet")).toMatchObject({
    desktopMode: "host",
    selectedMode: "vm",
    effectiveMode: "vm",
    leadModes: { duet: "vm" },
  });
  expect(await f.cli("mode", "vm", "--machine", "pc")).toMatchObject({
    desktopMode: "vm",
    accessLevel: "workers",
  });
  await expect(f.cli("mode", "screen", "--machine", "pc")).rejects.toThrow("desktop_mode_above_ceiling");
  expect((await f.settings.load()).machineAccess).toEqual({ pc: "workers" });
  await f.restart();
  expect(await f.state()).toMatchObject({ desktopMode: "host", leadModes: { duet: "vm" } });
  const beforeCeilingChange = await f.state();
  await f.settings.update((current) => ({
    ...current,
    machineAccess: { ...current.machineAccess, local: "workers" },
  }));
  expect(await f.state()).toMatchObject({ desktopMode: "host", selectedMode: "host", effectiveMode: "none" });
  expect((await f.state()).revision).not.toBe(beforeCeilingChange.revision);
  await expect(f.cli("mode", "screen", "--expected-revision", beforeCeilingChange.revision)).rejects.toThrow(
    "Settings changed",
  );
  await f.cli("mode", "none");
  await expect(f.cli("mode", "host", "--machine", "missing")).rejects.toThrow("unknown_machine");
});

it("production auth denies workers, captain, unknown bearers and owner revocation before the durable write", async () => {
  const f = await fixture();
  const initial = await f.state();
  const body = { schemaVersion: 1, expectedRevision: initial.revision, mode: "screen" };
  for (const bearer of ["worker", "joined-host", "captain", ""]) {
    expect((await f.request(DESKTOP_ACCESS_PATH, undefined, bearer)).status).toBe(401);
    expect((await f.request(DESKTOP_ACCESS_PATH, body, bearer)).status).toBe(401);
  }
  // Unknown fields cannot smuggle a ceiling or permission grant through a mode write.
  expect((await f.request(DESKTOP_ACCESS_PATH, { ...body, accessLevel: "screen" })).status).toBe(400);
  f.revokeAtCommit();
  expect((await f.request(DESKTOP_ACCESS_PATH, body)).status).toBe(403);
  expect((await new SettingsStore(f.settings.path).load()).computer.machines).toEqual({});
});

it("reports only named actor observations, expires them and never treats them as access authority", async () => {
  const f = await fixture();
  const observation = {
    actor: { bundleId: "test.acting-terminal", name: "Fixture terminal", pid: 123 },
    observedAt: new Date(f.now()).toISOString(),
    accessibility: "granted",
    screenRecording: "not_granted",
  };
  const publish = { schemaVersion: 1, observation };
  const before = await f.state();
  expect((await f.request(`${DESKTOP_ACCESS_PATH}/permissions`, publish, "worker")).status).toBe(401);
  expect((await f.request(`${DESKTOP_ACCESS_PATH}/permissions`, publish)).status).toBe(200);
  expect(await f.cli("permissions")).toEqual({ state: "observed", observation });
  expect(await f.state()).toMatchObject({
    revision: before.revision,
    desktopMode: "none",
    effectiveMode: "none",
  });
  f.advance(60_001);
  expect(await f.cli("permissions")).toEqual({ state: "unavailable", reason: "stale" });
  expect((await f.request(`${DESKTOP_ACCESS_PATH}/permissions`, publish)).status).toBe(400);
  await f.restart();
  expect(await f.cli("permissions")).toEqual({ state: "unavailable", reason: "not_checked" });
});

it("paired owner control can choose a mode; a supervise device cannot; neither can publish terminal observations", async () => {
  const f = await fixture();
  const supervise = await f.pair(SUPERVISE_GRANTS);
  const owner = await f.pair(TAKE_CONTROL_GRANTS);
  const initial = await f.state();
  const body = { schemaVersion: 1, expectedRevision: initial.revision, mode: "host" };
  expect((await f.request(DESKTOP_ACCESS_PATH, body, supervise)).status).toBe(403);
  expect((await f.request(DESKTOP_ACCESS_PATH, body, owner)).status).toBe(200);
  expect((await f.request(`${DESKTOP_ACCESS_PATH}/permissions`, {}, owner)).status).toBe(401);
  expect(await f.state()).toMatchObject({ desktopMode: "host" });
});

it("doorway routes carry bounded reads and mode writes, never actor publication or malformed queries", async () => {
  for (const path of [DESKTOP_ACCESS_PATH, `${DESKTOP_ACCESS_PATH}?machine=local&lead=duet`]) {
    expect(hostedOperatorAllows("GET", path)).toBe(true);
    expect(publicGatewayTargetFor("GET", path)).toBe("relay");
  }
  expect(hostedOperatorAllows("POST", DESKTOP_ACCESS_PATH)).toBe(true);
  for (const path of [
    `${DESKTOP_ACCESS_PATH}/permissions`,
    `${DESKTOP_ACCESS_PATH}?machine=local&machine=pc`,
    `${DESKTOP_ACCESS_PATH}?actor=forged`,
  ]) {
    expect(hostedOperatorAllows("GET", path)).toBe(false);
    expect(publicGatewayTargetFor("GET", path)).toBeUndefined();
    expect(hostedOperatorAllows("POST", path)).toBe(false);
  }
  const f = await fixture();
  await expect(f.cli("permissions", "--refresh", "--machine", "pc")).rejects.toThrow("acting terminal");
  await expect(f.cli("mode", "screen", "--expected-revision")).rejects.toThrow("Usage");
});

it("a real joined-host registration remains capped even when the controller preference was raised elsewhere", async () => {
  const f = await fixture();
  const code = randomBytes(32).toString("base64url");
  f.joins.start({
    name: "Owned fixture",
    platform: "darwin",
    directories: ["/fixture"],
    claimSecret: randomBytes(32).toString("base64url"),
    approvalHash: machineJoinHash(code),
  });
  const joined = await f.joins.approve(
    { code, accessLevel: "workers", directories: ["/fixture"] },
    async () => {},
  );
  const machine = joined.machineId;
  await f.settings.update((current) => ({
    ...current,
    machineAccess: { ...current.machineAccess, [machine]: "screen" },
  }));
  const before = await f.state(`?machine=${machine}`);
  expect(before.accessLevel).toBe("workers");
  await expect(f.cli("mode", "screen", "--machine", machine)).rejects.toThrow("desktop_mode_above_ceiling");
  expect(f.joins.accessCeiling(machine)).toBe("workers");
  expect(await f.cli("mode", "vm", "--machine", machine)).toMatchObject({
    desktopMode: "vm",
    accessLevel: "workers",
  });
});

it("two owner writes to one reviewed revision cannot overwrite each other", async () => {
  const f = await fixture();
  const before = await f.state();
  const responses = await Promise.all(
    ["host", "screen"].map((mode) =>
      f.request(DESKTOP_ACCESS_PATH, { schemaVersion: 1, expectedRevision: before.revision, mode }),
    ),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  const winner = DesktopAccessSnapshotSchema.parse(
    await responses.find((response) => response.status === 200)!.json(),
  );
  expect((await f.state()).desktopMode).toBe(winner.desktopMode);
});

it("adds desktop status to opted-in machine inventory while preserving strict old-client reads", async () => {
  const f = await fixture();
  await f.cli("mode", "host");
  const legacy = await (await f.request("/v1/machines")).json();
  const oldMachineSchema = MachineSchema.omit({ desktopAccess: true });
  for (const machine of legacy.machines) expect(oldMachineSchema.safeParse(machine).success).toBe(true);
  const extended = (await f.machineCli()) as { machines: Array<{ id: string; desktopAccess?: unknown }> };
  expect(extended.machines.find((machine: { id: string }) => machine.id === "local")).toMatchObject({
    desktopAccess: { desktopMode: "host", permissions: { state: "unavailable" } },
  });
  expect(extended.machines.every((machine: unknown) => MachineSchema.safeParse(machine).success)).toBe(true);
});

it.each(["account", "account-child", "account-grandchild"])(
  "desktop choices use the shared owner-device decision (%s)",
  async (deviceId) => {
    const f = await fixture(true);
    const initial = await f.state();
    const token = f.token(deviceId);
    const read = await f.request(DESKTOP_ACCESS_PATH, undefined, token);
    const write = await f.request(
      DESKTOP_ACCESS_PATH,
      {
        schemaVersion: 1,
        expectedRevision: initial.revision,
        mode: "host",
      },
      token,
    );
    expect({ read: read.status, write: write.status }).toEqual({ read: 403, write: 403 });
    expect((await f.settings.load()).computer.machines).toEqual({});
    expect((await f.request(`${DESKTOP_ACCESS_PATH}/permissions`, {}, token)).status).toBe(401);
  },
);

it("owner desktop choices remain available to a real owner pairing and its child", async () => {
  const f = await fixture();
  const owner = await f.pair(TAKE_CONTROL_GRANTS);
  const child = await f.pair(TAKE_CONTROL_GRANTS, owner);
  for (const token of [owner, child]) {
    const read = await f.request(DESKTOP_ACCESS_PATH, undefined, token);
    expect(read.status).toBe(200);
    const state = DesktopAccessSnapshotSchema.parse(await read.json());
    expect(
      (
        await f.request(
          DESKTOP_ACCESS_PATH,
          {
            schemaVersion: 1,
            expectedRevision: state.revision,
            mode: "host",
          },
          token,
        )
      ).status,
    ).toBe(200);
  }
  expect((await f.settings.load()).machineAccess).toEqual({ pc: "workers" });
  expect((await f.state()).desktopMode).toBe("host");
});
