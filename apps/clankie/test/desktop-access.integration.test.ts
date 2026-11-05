import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { createDesktopPermissionCheck } from "../src/desktop-permission-check.ts";
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

async function fixture(
  withAccountRecords = false,
  desktopPermissionCheck?: ReturnType<typeof createDesktopPermissionCheck>,
) {
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
      ...(desktopPermissionCheck === undefined ? {} : { desktopPermissionCheck }),
      settings,
      runtimes,
      eventLogPath: join(root, "events.jsonl"),
      deviceSessionKey: new Uint8Array(32).fill(19),
      clock: () => new Date(desktopPermissionCheck ? Date.now() : now),
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
    resetAuthCalls: () => {
      authCalls = 0;
      revokeAt = Infinity;
    },
    authCalls: () => authCalls,
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

it.each([1, 2, 3])(
  "paired owner revocation during final settings read %s prevents desktop persistence",
  async (readAt) => {
    const f = await fixture();
    const token = await f.pair(TAKE_CONTROL_GRANTS);
    const claims = new DeviceSessionSigner(new Uint8Array(32).fill(19)).verify(
      token,
      Math.floor(f.now() / 1000),
    );
    const initial = await f.state();
    f.resetAuthCalls();
    let injected = false;
    let afterOwnerReads = 0;
    const load = f.settings.load.bind(f.settings);
    f.settings.load = async () => {
      const current = await load();
      // The first two auth calls are route admission and the existing store guard.
      // Suspend each subsequent real read while a concurrent HTTP revoke completes.
      if (!injected && f.authCalls() === 2 && ++afterOwnerReads === readAt) {
        injected = true;
        const revoked = await f.request(`/v1/devices/${claims.deviceId}/revoke`, {}, "owner");
        expect(revoked.status).toBe(200);
      }
      return current;
    };
    const response = await f.request(
      DESKTOP_ACCESS_PATH,
      { schemaVersion: 1, expectedRevision: initial.revision, mode: "host" },
      token,
    );
    const data = await response.json();
    const persisted = (await new SettingsStore(f.settings.path).load()).computer.machines;
    const ownerRead = await f.request(DESKTOP_ACCESS_PATH, undefined, token);
    expect(injected).toBe(true);
    expect(ownerRead.status).toBe(401);
    expect(response.status, JSON.stringify(data)).toBe(403);
    expect(data.error).toBe("desktop_owner_revoked");
    expect(persisted).toEqual({});
  },
);

// The terminal fixture implements the real JSONL boundary and executes a real
// diagnostic subprocess. Its observations are labelled fixtures, not native TCC proof.
async function permissionTerminal(native = false, desktop = false, desktopAddress = "t2k") {
  const root = await mkdtemp("/tmp/clankie-permission-test-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const helper = native
    ? new URL("../../tui/native/desktop-permission-probe.mjs", import.meta.url).pathname
    : join(root, "diagnostic.mjs");
  const calls: { method: string; params: any }[] = [];
  const children: ChildProcess[] = [];
  let mode = "observed";
  let bound = true;
  let beforeReply = async (_method: string) => {};
  let beforeSelect = async () => {};
  const script = (kind: string) => `import {writeFile} from 'node:fs/promises';
const [output,nonce]=process.argv.slice(2);
const result=${JSON.stringify(kind)} === 'context' ? {state:'unavailable',reason:'terminal_context_unavailable'} : {state:'observed',observation:{actor:{bundleId:'test.fixture.terminal',name:'Fixture terminal',pid:process.pid},observedAt:new Date(Date.now()+(${kind === "stale" ? -20000 : kind === "future" ? 20000 : 0})).toISOString(),accessibility:'granted',screenRecording:'not_granted'}};
await writeFile(output,JSON.stringify({nonce:${kind === "nonce" ? "'wrong'" : "nonce"},result}),{flag:'wx',mode:0o600});`;
  const server = createServer((socket) => {
    let text = "";
    socket.on("data", (bytes) => {
      text += bytes;
      if (!text.includes("\n")) return;
      const request = JSON.parse(text);
      text = "";
      if (request.method === "hello") {
        socket.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { methods: ["terminal.run", "terminal.kill", "terminal.rm"] },
          }) + "\n",
        );
        return;
      }
      calls.push(request);
      void (async () => {
        if (["layout.apply", "terminal.run"].includes(request.method)) {
          if (!desktop) {
            expect(request.params.focus).toBe(false);
            expect(request.params.tab_id).toBeUndefined();
          } else {
            expect(request.params.keep).toBe(false);
            expect(request.params.rm).toBe(true);
            expect(request.params.no_parent).toBe(true);
            expect(request.params.no_notify).toBe(true);
            expect(request.params.labels).toEqual({});
          }
          const argv = desktop ? request.params.argv : request.params.root.command;
          expect(argv.slice(0, 2)).toEqual([process.execPath, helper]);
          expect(desktop ? request.params.env : request.params.root.env).toEqual({});
          if (mode !== "timeout" && mode !== "unconfirmed") {
            if (!native) await writeFile(helper, script(mode));
            const child = spawn(process.execPath, argv.slice(1), {
              stdio: "ignore",
              env: {
                ...process.env,
                TERM_PROGRAM: "Forged terminal",
                __CFBundleIdentifier: "test.forged.terminal",
              },
            });
            children.push(child);
          }
        }
        await beforeReply(request.method);
        if (mode === "unconfirmed") {
          socket.end();
          return;
        }
        socket.end(
          JSON.stringify({
            id: request.id,
            result:
              request.method === "terminal.run"
                ? { address: desktopAddress }
                : request.method === "layout.apply"
                  ? { layout: { root: { type: "pane", pane_id: "wfixture:pcheck" } } }
                  : { closed: true },
          }) + "\n",
        );
      })().catch((error) => {
        socket.destroy(error);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(join(root, "terminal.sock"), resolve));
  cleanups.push(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise<void>((resolve) => child.once("close", resolve));
      }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const check = createDesktopPermissionCheck({
    platform: "darwin",
    helper,
    timeoutMs: native ? 12_000 : 1000,
    binding: async () => {
      await beforeSelect();
      return bound
        ? {
            kind: desktop ? "desktop" : "herdr",
            binding: { runtime: "external", session: "fixture", socketPath: join(root, "terminal.sock") },
          }
        : undefined;
    },
  });
  return {
    check,
    calls,
    mode: (value: string) => {
      mode = value;
    },
    unbind: () => {
      bound = false;
    },
    onSelect: (callback: typeof beforeSelect) => {
      beforeSelect = callback;
    },
    onReply: (callback: typeof beforeReply) => {
      beforeReply = callback;
    },
  };
}

it("owner API and CLI request a fresh terminal subprocess observation without changing choices or restamping a cache read", async () => {
  const terminal = await permissionTerminal();
  const f = await fixture(false, terminal.check);
  const owner = await f.pair(TAKE_CONTROL_GRANTS);
  const child = await f.pair(TAKE_CONTROL_GRANTS, owner);
  const before = await f.settings.load();
  for (const token of [owner, child]) {
    const response = await f.request(
      "/v1/operator/computer/permissions/refresh",
      { schemaVersion: 1 },
      token,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "observed",
      observation: { actor: { name: "Fixture terminal" } },
    });
  }
  const result = (await f.cli("permissions", "--request", "--json")) as any;
  expect(result).toMatchObject({
    state: "observed",
    observation: { actor: { bundleId: "test.fixture.terminal" } },
  });
  expect((await f.state()).permissions).toEqual(result);
  expect((await f.state()).permissions).toEqual(result);
  expect(await f.settings.load()).toEqual(before);
  expect(terminal.calls.filter((c) => c.method === "layout.apply")).toHaveLength(3);
  expect(terminal.calls.filter((c) => c.method === "pane.close")).toHaveLength(3);
  expect(terminal.calls.every((c) => ["layout.apply", "pane.close"].includes(c.method))).toBe(true);
});

it("fresh check refuses visitors, descendants, supervisors and captain bearers before terminal dispatch", async () => {
  const terminal = await permissionTerminal();
  const f = await fixture(true, terminal.check);
  const supervisor = await f.pair(SUPERVISE_GRANTS);
  for (const token of [
    f.token("account"),
    f.token("account-child"),
    f.token("account-grandchild"),
    supervisor,
    "captain",
    "worker",
    "",
  ]) {
    expect(
      (await f.request("/v1/operator/computer/permissions/refresh", { schemaVersion: 1 }, token)).status,
    ).toBeGreaterThanOrEqual(400);
  }
  expect(terminal.calls).toEqual([]);
});

it.each([
  ["context", "terminal_context_unavailable"],
  ["timeout", "timed_out"],
  ["nonce", "invalid_observation"],
  ["stale", "invalid_observation"],
  ["future", "invalid_observation"],
  ["unconfirmed", "launch_unconfirmed"],
])(
  "fresh check returns bounded %s failure without replaying the diagnostic or publishing a report",
  async (mode, reason) => {
    const terminal = await permissionTerminal();
    terminal.mode(mode!);
    const f = await fixture(false, terminal.check);
    const before = await f.settings.load();
    expect(await f.cli("permissions", "--request")).toEqual({ state: "unavailable", reason });
    expect((await f.state()).permissions).toEqual({ state: "unavailable", reason: "not_checked" });
    expect(await f.settings.load()).toEqual(before);
    expect(terminal.calls.filter((c) => c.method === "layout.apply")).toHaveLength(1);
  },
);

it.each(["layout.apply", "pane.close"])(
  "owner revocation during %s refuses publication after native preparation",
  async (method) => {
    const terminal = await permissionTerminal();
    const f = await fixture(false, terminal.check);
    const token = await f.pair(TAKE_CONTROL_GRANTS);
    const claims = new DeviceSessionSigner(new Uint8Array(32).fill(19)).verify(
      token,
      Math.floor(Date.now() / 1000),
    )!;
    terminal.onReply(async (current) => {
      if (current === method)
        expect((await f.request(`/v1/devices/${claims.deviceId}/revoke`, {}, "owner")).status).toBe(200);
    });
    const response = await f.request(
      "/v1/operator/computer/permissions/refresh",
      { schemaVersion: 1 },
      token,
    );
    expect(response.status).toBe(403);
    expect((await f.state()).permissions).toEqual({ state: "unavailable", reason: "not_checked" });
  },
);

it("a changed terminal during cleanup cannot publish the old terminal's observation", async () => {
  const terminal = await permissionTerminal();
  const f = await fixture(false, terminal.check);
  terminal.onReply(async (method) => {
    if (method === "pane.close") terminal.unbind();
  });
  expect(await f.cli("permissions", "--request")).toEqual({
    state: "unavailable",
    reason: "terminal_changed",
  });
  expect((await f.state()).permissions).toEqual({ state: "unavailable", reason: "not_checked" });
});

it("fresh check route has a closed body/query and stays unavailable without a configured terminal", async () => {
  const f = await fixture();
  const path = "/v1/operator/computer/permissions/refresh";
  expect(await f.cli("permissions", "--request")).toEqual({
    state: "unavailable",
    reason: "terminal_unavailable",
  });
  for (const body of [
    { schemaVersion: 1, command: ["bad"] },
    { schemaVersion: 1, observation: {} },
    { schemaVersion: 1, machineId: "pc" },
    {},
  ])
    expect((await f.request(path, body)).status).toBe(400);
  expect((await f.request(path + "?machine=local", { schemaVersion: 1 })).status).toBe(400);
  expect(hostedOperatorAllows("POST", path)).toBe(true);
  expect(hostedOperatorAllows("POST", path + "?machine=local")).toBe(false);
  expect(publicGatewayTargetFor("POST", path)).toBe("relay");
});

it("only one fresh check runs at a time and a timeout never publishes an older cached result", async () => {
  const terminal = await permissionTerminal();
  const f = await fixture(false, terminal.check);
  expect(await f.cli("permissions", "--request")).toMatchObject({ state: "observed" });
  terminal.mode("timeout");
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  terminal.onReply(async (method) => {
    if (method === "layout.apply") started();
  });
  const first = f.cli("permissions", "--request");
  await pending;
  expect(await f.cli("permissions", "--request")).toEqual({
    state: "unavailable",
    reason: "check_in_progress",
  });
  expect(await first).toEqual({ state: "unavailable", reason: "timed_out" });
  expect((await f.state()).permissions.state).toBe("observed");
  expect(terminal.calls.filter((c) => c.method === "layout.apply")).toHaveLength(2);
});

it("the shipped diagnostic through real API and IPC never substitutes caller-supplied terminal identity", async () => {
  const terminal = await permissionTerminal(true);
  const f = await fixture(false, terminal.check);
  const result = (await f.cli("permissions", "--request")) as {
    state: string;
    observation?: { actor: { name: string; bundleId: string } };
    reason?: string;
  };
  console.info("Native diagnostic result:", JSON.stringify(result));
  if (result.state === "observed") {
    expect(result.observation!.actor.name).not.toBe("Forged terminal");
    expect(result.observation!.actor.bundleId).not.toBe("test.forged.terminal");
  } else expect(["terminal_context_unavailable", "unsupported"]).toContain(result.reason);
  expect(terminal.calls.filter((c) => c.method === "layout.apply")).toHaveLength(1);
  expect(terminal.calls.filter((c) => c.method === "pane.close")).toHaveLength(1);
}, 15000);

it("revocation during request preparation prevents even the first diagnostic launch", async () => {
  const terminal = await permissionTerminal();
  const f = await fixture(false, terminal.check);
  f.revokeAtCommit();
  const response = await f.request("/v1/operator/computer/permissions/refresh", { schemaVersion: 1 });
  expect(response.status).toBe(403);
  expect(terminal.calls).toEqual([]);
});

it.each(["t1", "t909", "t2k", "t6kf3jk5"])(
  "desktop-host API accepts native address %s and cleans up only that diagnostic",
  async (address) => {
    const terminal = await permissionTerminal(false, true, address);
    const f = await fixture(false, terminal.check);
    expect(await f.cli("permissions", "--request")).toMatchObject({
      state: "observed",
      observation: { actor: { name: "Fixture terminal" } },
    });
    expect(terminal.calls.map((call) => call.method)).toEqual([
      "terminal.run",
      "terminal.kill",
      "terminal.rm",
    ]);
    for (const call of terminal.calls.filter((call) => call.method !== "terminal.run"))
      expect(call.params.terminal).toBe(address);
  },
);

it.each(["terminal.run", "terminal.kill", "terminal.rm"])(
  "desktop-host revocation during %s prevents observation publication",
  async (method) => {
    const terminal = await permissionTerminal(false, true);
    const f = await fixture(false, terminal.check);
    const token = await f.pair(TAKE_CONTROL_GRANTS);
    const claims = new DeviceSessionSigner(new Uint8Array(32).fill(19)).verify(
      token,
      Math.floor(Date.now() / 1000),
    )!;
    terminal.onReply(async (current) => {
      if (current === method)
        expect((await f.request(`/v1/devices/${claims.deviceId}/revoke`, {}, "owner")).status).toBe(200);
    });
    expect(
      (await f.request("/v1/operator/computer/permissions/refresh", { schemaVersion: 1 }, token)).status,
    ).toBe(403);
    expect((await f.state()).permissions).toEqual({ state: "unavailable", reason: "not_checked" });
  },
);

it("concurrent API requests cannot launch twice while asynchronous host selection is pending", async () => {
  const terminal = await permissionTerminal();
  const f = await fixture(false, terminal.check);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const selected = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let first = true;
  terminal.onSelect(async () => {
    if (first) {
      first = false;
      entered();
      await gate;
    }
  });
  const request = f.cli("permissions", "--request");
  await selected;
  try {
    expect(await f.cli("permissions", "--request")).toEqual({
      state: "unavailable",
      reason: "check_in_progress",
    });
  } finally {
    release();
  }
  expect(await request).toMatchObject({ state: "observed" });
  expect(terminal.calls.filter((c) => c.method === "layout.apply")).toHaveLength(1);
});

it.each([
  "",
  "t0",
  "t01",
  "t2a",
  "t2l",
  "t2K",
  "other/t2k",
  "t2k/other",
  "t2k\n",
  "t2k\u2028",
  "t9zzzzzz",
  "t10000000",
])(
  "desktop-host API refuses non-native address %j without reading or cleaning up an unrelated terminal",
  async (address) => {
    const terminal = await permissionTerminal(false, true, address);
    const f = await fixture(false, terminal.check);
    expect(await f.cli("permissions", "--request")).toEqual({
      state: "unavailable",
      reason: "launch_unconfirmed",
    });
    expect((await f.state()).permissions).toEqual({ state: "unavailable", reason: "not_checked" });
    expect(terminal.calls.map((call) => call.method)).toEqual(["terminal.run"]);
  },
);
