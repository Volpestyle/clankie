import { spawn, execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Socket } from "node:net";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { afterEach, expect, it, vi } from "vitest";
import {
  createResourceGovernor,
  createSimctlAdapter,
  defaultResourcePolicy,
  processIdentity,
  type SimulatorResult,
} from "@clankie/fleet-resources";
import { createFleetResourceRuntime } from "../src/fleet-resource-runtime.ts";
import { createFleetResourceRoutes } from "../src/fleet-resource-routes.ts";
import { registerSeatRoutes } from "../src/app/seat-routes.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import type { FleetSeatHook } from "@clankie/protocol";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import { clientPid } from "../src/local-fleet-proof.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { runSimulatorCommand } from "../../tui/src/command/fleet-resources.ts";
import { FileCredentialStore } from "@clankie/credential-broker";

const execute = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const runtime = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
const deviceType = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  await closed;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "wait-liveness-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("XDG_")) delete env[name];
  for (const name of [
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
  ]) {
    env[name] = join(root, name);
    await mkdir(env[name]!, { recursive: true });
  }
  const statePath = join(root, "simctl.json"),
    log = join(root, "simctl.jsonl");
  await writeFile(statePath, JSON.stringify({ devices: {} }));
  await writeFile(log, "");
  const directory = join(root, "registry");
  const governor = createResourceGovernor({
    directory,
    probe: async () => ({ loadRatio: 0, cpuRatio: 0, availableMemoryMb: 32768 }),
    simulatorBootSettleMs: 0,
    heavyJobSettleMs: 0,
  });
  const resources = await createFleetResourceRuntime({
    governor,
    policy: async () => undefined,
    simulator: {
      clock: () => now,
      adapter: createSimctlAdapter({
        run: async (args, timeout) =>
          (
            await execute(
              process.execPath,
              [resolve("packages/fleet-resources/test/fixtures/simctl.mjs"), statePath, log, ...args],
              { env, timeout },
            )
          ).stdout,
      }),
    },
  });
  cleanups.push(() => resources.close());
  await governor.configure({
    ...defaultResourcePolicy(),
    heavySlots: 1,
    simulatorSlots: 1,
    minAvailableMemoryMb: 0,
    minFreeDiskGb: 0,
  });
  let child: ChildProcess;
  let sessionId = "fixture-original-session",
    replaced = false,
    admitted = true;
  const session = () => ({ source: "herdr:claude", kind: "id" as const, value: sessionId });
  const native = async () => {
    const identity = child?.pid ? await processIdentity(child.pid) : undefined;
    if (!identity) throw Error("Fixture native process unavailable");
    return {
      fleet: "default",
      pane: "w1:p1",
      nativeOccupantId: occupantIdForHerdrSession(session()),
      binding: { socketPath: join(root, "fixture.sock") },
      shell: { pid: identity.pid, startTime: identity.startTime },
      processes: [{ pid: identity.pid, startTime: replaced ? "replaced-birth" : identity.startTime }],
    };
  };
  resources.bindSeats({
    isLocalFleet: async () => true,
    resolve: async (id) =>
      ["w1:p1", "fixture-seat"].includes(id)
        ? {
            terminalId: "fixture-seat",
            paneId: "w1:p1",
            agent: "claude",
            status: "working",
            title: "Native fixture",
            session: session(),
          }
        : undefined,
    proof: async () => native(),
  });
  // Real TCP kernel ownership and native birth/ancestry. Only harness discovery
  // is a surrogate: the server pins this fixture process as its native seat.
  const socketOwners = new WeakMap<Socket, number>();
  const prove = async (socket: Socket, pane: string) => {
    if (!admitted || pane !== "w1:p1" || socket.destroyed) return false;
    let pid = socketOwners.get(socket);
    if (!pid) {
      const output = await execute("/usr/sbin/lsof", ["-nP", "-iTCP", "-Fpn"]);
      pid = clientPid(output.stdout, socket.remotePort!, socket.localPort!);
      if (!pid) return false;
      socketOwners.set(socket, pid);
    }
    const caller = await processIdentity(pid),
      parent = caller && (await processIdentity(caller.ppid));
    const holder = await native().catch(() => undefined);
    return (
      !!caller &&
      !!parent &&
      !!holder &&
      parent.pid === child.pid &&
      parent.startTime === holder.processes[0]!.startTime
    );
  };
  const link = new LocalFleetLink({
    directory: join(root, "links"),
    binding: async () => undefined,
    prove,
    projectProof: async (socket, pane) => ((await prove(socket, pane)) ? native() : undefined),
  });
  const app = new Hono();
  let legacy = false;
  const hooks: FleetSeatHook[] = [];
  app.use("/v1/fleet/seats/:paneId/hook", async (context, next) => {
    if (legacy) {
      const body = await context.req.json();
      if (body.occurredAt !== undefined || body.agentId !== undefined || body.event === "PostToolUse")
        return context.json({ error: "invalid_request" }, 400);
    }
    await next();
  });
  registerSeatRoutes({
    app,
    dependencies: {
      captain: {
        ...createStubCaptain(),
        recordSeatHook: async (_pane, hook) => {
          hooks.push(hook);
          return true;
        },
      },
      fleetResources: resources,
      localFleet: link,
    },
    authenticateLane: async () => ({
      denial: Response.json({ error: "operator_required" }, { status: 403 }),
    }),
  });
  app.route(
    "/",
    createFleetResourceRoutes(
      async (request) =>
        request.headers.get("authorization") === "Bearer fixture-owner" ? true : "forbidden",
      resources,
    ),
  );
  const nativeFetch = link.fetch(app.fetch);
  const server = serve({
    fetch: (request, env) =>
      new URL(request.url).pathname.startsWith("/v1/fleet/seats/")
        ? nativeFetch(request, env)
        : app.fetch(request),
    hostname: "127.0.0.1",
    port: 0,
  });
  if (!server.listening) await once(server, "listening");
  cleanups.push(async () => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await mkdir(join(root, "state", "links"), { recursive: true });
  await writeFile(
    join(root, "state", "links", "fixture.json"),
    JSON.stringify({
      schemaVersion: 2,
      authentication: "local-process",
      fleet: "default",
      socket: "fixture",
      url: host,
    }),
  );
  child = spawn(process.execPath, [resolve("apps/clankie/test/fixtures/resource-activity-engine.mjs")], {
    env: {
      ...env,
      CLANKIE_STATE: join(root, "state"),
      ACTIVITY_FIXTURE_ROOT: root,
      ACTIVITY_PLUGIN_ROOT: resolve("integrations/claude-plugin/worker"),
      ACTIVITY_MOD_PATH: resolve("integrations/claude-plugin/worker/mods/tool-catalog.mjs"),
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "fixture",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let errors = "";
  child.stderr!.on("data", (data) => (errors += data));
  cleanups.push(() => stop(child));
  expect((await once(child, "message"))[0], errors).toEqual({ ready: true });
  let nextId = 0;
  const send = async (message: Record<string, unknown>) => {
    const id = ++nextId;
    const reply = once(child, "message");
    child.send!({ ...message, id, now });
    const received = (await reply)[0];
    expect(received, errors).toMatchObject({ id, ok: true });
    if (received.activityExitCode !== undefined || message.expectedActivityExit !== undefined)
      expect(received.activityExitCode, errors).toBe(message.expectedActivityExit ?? 0);
  };
  const cli = (action: string, data: Record<string, unknown>) =>
    runSimulatorCommand([action, JSON.stringify(data)], {
      host,
      env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" },
      operatorCredentialStore: new FileCredentialStore(join(root, "credentials.json")),
    });
  const owner = { seatId: "fixture-seat", holderId: `claude:${sessionId}` };
  const acquire = async (holderId = owner.holderId) => {
    const result = (await cli("acquire", { ...owner, holderId, deviceType, runtime })) as SimulatorResult;
    if (result.outcome !== "acquired") throw Error(JSON.stringify(result));
    return result.lease;
  };
  return {
    root,
    legacy: () => (legacy = true),
    hooks: () => hooks,
    host,
    directory,
    resources,
    governor,
    send,
    acquire,
    owner,
    child,
    native,
    cli,
    advance: (ms: number) => (now += ms),
    now: () => now,
    setSession: (id: string) => (sessionId = id),
    replace: (value = true) => (replaced = value),
    deny: () => (admitted = false),
    devices: async () => JSON.parse(await readFile(statePath, "utf8")),
  };
}

it.skipIf(process.platform !== "darwin")(
  "original-native mod renews exact quiet child turns through kernel-authenticated admission and the public simulator CLI; replay/loss/prompt/session fences expire",
  async () => {
    const f = await fixture();
    await f.send({ event: "session.start", input: { isInteractive: true } });
    // Generated root turn IDs have no verified root discriminator. This source
    // deliberately refuses to renew root leases from child or generic turns.
    const root = await f.acquire();
    expect((await f.governor.simulatorReservations())[0]?.id).toBe(root.id);
    await f.send({
      event: "turn.start",
      input: { turnId: "root", agentId: "a2222222222222222" },
      tick: true,
    });
    f.advance(600_001);
    await f.resources.simulators.tick();
    expect(await f.governor.simulatorReservations()).toHaveLength(0);
    await f.send({ event: "turn.complete", input: { turnId: "root", agentId: "a2222222222222222" } });
    const childId = "a1111111111111111";
    const childHolder = `${f.owner.holderId}:agent:${childId}`;
    const lease = await f.acquire(childHolder);
    await f.send({
      children: [{ id: childId, type: "general-purpose", status: "running" }],
      event: "turn.start",
      input: { turnId: "quiet-turn", agentId: childId },
      tick: true,
    });
    // A quiet child turn crosses both the five-minute old-evidence window and the
    // ten-minute lease timeout, without tool activity, model calls or touches.
    for (let elapsed = 0; elapsed < 610_000; elapsed += 14_000) {
      f.advance(14_000);
      await f.send({ tick: true });
    }
    expect((await f.governor.simulatorReservations()).map((row) => row.id)).toEqual([lease.id]);
    await f.send({
      children: [{ id: childId, type: "general-purpose", status: "idle" }],
      event: "turn.complete",
      input: { turnId: "quiet-turn", agentId: childId },
    });
    const promptAt = f.now();
    // Repeated idle renewals must preserve the original prompt deadline.
    f.advance(599_999);
    await f.send({ tick: true });
    expect(await f.governor.simulatorReservations()).toHaveLength(1);
    f.advance(1);
    await f.resources.simulators.tick();
    expect(f.now() - promptAt).toBe(600_000);
    expect(await f.governor.simulatorReservations()).toHaveLength(0);
    expect((await f.devices()).devices[runtime][0].state).toBe("Shutdown");

    const next = await f.acquire(childHolder);
    await f.send({
      children: [{ id: childId, type: "general-purpose", status: "running" }],
      event: "turn.start",
      input: { turnId: "second", agentId: childId },
      tick: true,
    });
    f.deny();
    await f.send({ tick: true, expectedActivityExit: 1 });
    const proof = await f.native();
    const activity = {
      instanceStartedAt: new Date(f.now()).toISOString(),
      checkedAt: new Date(f.now()).toISOString(),
      sequence: 0,
      children: [
        { agentId: childId, stateSince: new Date(f.now()).toISOString(), state: "working" as const },
      ],
      producerPid: f.child.pid!,
    };
    const hook = {
      schemaVersion: 1 as const,
      event: "NativeActivity" as const,
      sessionId: "fixture-original-session",
      activity,
    };
    // Real admitted state cannot be replaced by a replay, future or other producer.
    expect(
      await f.resources.recordNativeActivity(
        "w1:p1",
        { ...hook, activity: { ...activity, checkedAt: new Date(f.now() + 1).toISOString() } },
        proof,
      ),
    ).toBe(false);
    expect(
      await f.resources.recordNativeActivity(
        "w1:p1",
        { ...hook, activity: { ...activity, producerPid: process.pid } },
        proof,
      ),
    ).toBe(false);
    expect(await f.resources.recordNativeActivity("w1:p1", hook, proof)).toBe(true);
    expect(await f.resources.recordNativeActivity("w1:p1", hook, proof)).toBe(false);
    f.advance(600_001); // Native renewals lost: stale working pane is not time.
    expect(await f.resources.recordNativeActivity("w1:p1", hook, proof)).toBe(false);
    await f.resources.simulators.tick();
    expect(await f.governor.simulatorReservations()).toHaveLength(0);
    expect(next.id).not.toBe(lease.id);
    f.setSession("replacement-session");
    expect(
      await f.resources.recordNativeActivity(
        "w1:p1",
        { ...hook, activity: { ...activity, sequence: 1, checkedAt: new Date(f.now()).toISOString() } },
        proof,
      ),
    ).toBe(false);
    f.setSession("fixture-original-session");
    f.replace();
    expect(
      await f.resources.recordNativeActivity(
        "w1:p1",
        {
          ...hook,
          activity: { ...activity, sequence: 2, checkedAt: new Date(f.now()).toISOString() },
        },
        proof,
      ),
    ).toBe(false);
    f.replace(false);
    const doomed = await f.acquire(childHolder);
    await stop(f.child);
    expect(
      await f.resources.recordNativeActivity(
        "w1:p1",
        {
          ...hook,
          activity: { ...activity, sequence: 3, checkedAt: new Date(f.now()).toISOString() },
        },
        proof,
      ),
    ).toBe(false);
    await f.resources.simulators.tick();
    expect(await f.governor.simulatorReservations()).toHaveLength(0);
    expect(
      (await f.devices()).devices[runtime].find((device: { udid: string }) => device.udid === doomed.deviceId)
        .state,
    ).toBe("Shutdown");
  },
);

it.skipIf(process.platform !== "darwin").each(["root", "child"])(
  "exact native holder heavy queue and permit retain the lease; copied labels outside its process ancestry do not (%s)",
  async (scope) => {
    const f = await fixture();
    if (scope === "child") f.owner.holderId += ":agent:a3333333333333333";
    await f.send({ event: "session.start", input: { isInteractive: true } });
    const lease = await f.acquire();
    const busyReceipt = join(f.root, "busy-ready"),
      busyRelease = join(f.root, "busy-release"),
      release = join(f.root, "holder-release");
    const busy = f.governor.runHeavy(
      process.execPath,
      [
        "-e",
        "const fs = require('node:fs'); fs.writeFileSync(process.argv[1], 'ready'); const timer = setInterval(() => { if (fs.existsSync(process.argv[2])) { clearInterval(timer); process.exit(); } }, 20);",
        busyReceipt,
        busyRelease,
      ],
      { seatId: "unrelated", holderId: "unrelated" },
    );
    cleanups.push(async () => {
      await writeFile(busyRelease, "release");
      await busy;
    });
    await vi.waitFor(async () => expect(await readFile(busyReceipt, "utf8")).toBe("ready"));
    await f.send({ heavy: "start", directory: f.directory, release, holderId: f.owner.holderId });
    cleanups.push(() => f.send({ heavy: "stop" }));
    expect((await f.governor.snapshot()).queue).toContainEqual(
      expect.objectContaining({ kind: "heavy", holderId: f.owner.holderId }),
    );
    f.advance(600_001);
    await f.resources.simulators.tick();
    expect((await f.governor.simulatorReservations())[0]?.id).toBe(lease.id);
    await writeFile(busyRelease, "release");
    await busy;
    await f.send({ heavy: "ready" });
    f.advance(600_001);
    await f.resources.simulators.tick();
    expect((await f.governor.simulatorReservations())[0]?.id).toBe(lease.id);
    await f.send({ heavy: "stop" });
    f.advance(599_999);
    await f.resources.simulators.tick();
    expect(await f.governor.simulatorReservations()).toHaveLength(1);
    f.advance(2);
    await f.resources.simulators.tick();
    expect(await f.governor.simulatorReservations()).toHaveLength(0);

    const next = await f.acquire();
    const copied = f.governor.runHeavy(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {
      ...f.owner,
    });
    // Registration is observed through the real journal before advancing time.
    await vi.waitFor(async () =>
      expect((await f.governor.snapshot()).leases).toContainEqual(
        expect.objectContaining({ kind: "heavy", holderId: f.owner.holderId }),
      ),
    );
    f.advance(600_001);
    await f.resources.simulators.tick();
    expect(await f.governor.simulatorReservations()).toHaveLength(0);
    expect(next.id).not.toBe(lease.id);
    // End only the governed command allocated by this proof.
    await f.governor.close();
    await copied;
  },
);

it.skipIf(process.platform !== "darwin")(
  "root hook events renew only their exact session for one finite event-time idle window",
  async () => {
    const f = await fixture();
    const hook = async (event: string, occurredAt = f.now(), extra = {}) =>
      f.send({
        hook: {
          schemaVersion: 1,
          event,
          sessionId: "fixture-original-session",
          occurredAt: new Date(occurredAt).toISOString(),
          ...extra,
        },
      });
    const lease = await f.acquire();
    f.advance(590_000);
    const eventAt = f.now();
    await hook("UserPromptSubmit");
    f.advance(20_000);
    await f.resources.simulators.tick();
    expect((await f.governor.simulatorReservations()).map((row) => row.id)).toEqual([lease.id]);
    // A replay keeps the original event deadline, not receipt time.
    await hook("UserPromptSubmit", eventAt);
    await hook("Stop");
    await hook("StopFailure");
    await hook("SessionEnd");
    f.advance(579_999);
    await f.resources.simulators.tick();
    expect(await f.governor.simulatorReservations()).toHaveLength(1);
    f.advance(1);
    await f.resources.simulators.tick();
    expect(await f.governor.simulatorReservations()).toHaveLength(0);
    // Esc has no Stop: the finite event alone must still expire.
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const next = await f.acquire();
      f.advance(590_000);
      await hook(event);
      f.advance(20_000);
      await f.resources.simulators.tick();
      expect((await f.governor.simulatorReservations()).map((row) => row.id)).toEqual([next.id]);
      f.advance(580_000);
      await f.resources.simulators.tick();
      expect(await f.governor.simulatorReservations()).toHaveLength(0);
    }
    await f.acquire();
    f.advance(590_000);
    await hook("PreToolUse", f.now(), { sessionId: "another-session" });
    await hook("PreToolUse", f.now(), { agentId: "child" });
    await hook("PreToolUse", f.now() + 1);
    await hook("PreToolUse", f.now() - 600_001);
    f.advance(10_001);
    await f.resources.simulators.tick();
    expect(await f.governor.simulatorReservations()).toHaveLength(0);
    // Root activity cannot borrow a native child's separately owned lease.
    await f.acquire(`${f.owner.holderId}:agent:child`);
    f.advance(590_000);
    await hook("UserPromptSubmit");
    f.advance(10_001);
    await f.resources.simulators.tick();
    expect(await f.governor.simulatorReservations()).toHaveLength(0);
    await f.acquire();
    f.advance(590_000);
    f.deny();
    await f.send({
      hook: {
        schemaVersion: 1,
        event: "PreToolUse",
        sessionId: "fixture-original-session",
        occurredAt: new Date(f.now()).toISOString(),
      },
      hookExitCode: 1,
    });
    f.advance(10_001);
    await f.resources.simulators.tick();
    expect(await f.governor.simulatorReservations()).toHaveLength(0);
  },
);

it.skipIf(process.platform !== "darwin")(
  "the shipped worker hook reports root event time, fences child events and falls back on a strict older host",
  async () => {
    const f = await fixture();
    const lease = await f.acquire();
    // Helper runs on the real wall clock; service fixture time is safely later.
    f.advance(120_000);
    await f.send({
      workerHook: {
        hook_event_name: "PreToolUse",
        session_id: "fixture-original-session",
        tool_name: "Read",
        tool_input: { file_path: "PRIVATE_PATH" },
      },
    });
    const pre = f.hooks().at(-1)!;
    expect(pre).toMatchObject({
      event: "PreToolUse",
      sessionId: "fixture-original-session",
      toolName: "Read",
    });
    expect(pre.occurredAt).toBeDefined();
    expect(pre.toolInput).toBeUndefined();
    expect((await f.governor.simulatorReservations())[0]).toMatchObject({
      id: lease.id,
      lastUsedAtMs: Date.parse(pre.occurredAt!),
    });
    await f.send({
      workerHook: {
        hook_event_name: "PostToolUse",
        session_id: "fixture-original-session",
        tool_name: "Read",
        agent_id: "child",
      },
    });
    expect(f.hooks().at(-1)).toMatchObject({ event: "PostToolUse", agentId: "child" });
    expect((await f.governor.simulatorReservations())[0]?.lastUsedAtMs).toBe(Date.parse(pre.occurredAt!));
    f.legacy();
    await f.send({
      workerHook: {
        hook_event_name: "PreToolUse",
        session_id: "fixture-original-session",
        tool_name: "Read",
      },
    });
    expect(f.hooks().at(-1)).toEqual({
      schemaVersion: 1,
      event: "PreToolUse",
      sessionId: "fixture-original-session",
      toolName: "Read",
    });
    const count = f.hooks().length;
    await f.send({
      workerHook: {
        hook_event_name: "PostToolUse",
        session_id: "fixture-original-session",
        tool_name: "Read",
      },
    });
    expect(f.hooks()).toHaveLength(count);
  },
);
