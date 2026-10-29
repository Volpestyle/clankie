import { spawn, execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Socket } from "node:net";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { afterEach, expect, it, vi, type TestContext } from "vitest";
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
import { runSeatHookCommand } from "../../tui/src/command/seat-hook.ts";
import { runSimulatorCommand } from "../../tui/src/command/fleet-resources.ts";
import { FileCredentialStore } from "@clankie/credential-broker";
import { LocalCodexSeats } from "../src/local-codex-seats.ts";

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

async function fixture(context?: TestContext, detachedCodex = false) {
  const stages: unknown[] = [];
  const trace = (stage: string, data: Record<string, unknown> = {}) => {
    if (!context) return;
    stages.push({ stage, utc: new Date().toISOString(), elapsedMs: Math.round(performance.now()), ...data });
    if (stages.length > 64) stages.shift();
  };
  const observed = async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
    if (!context) return work();
    const started = performance.now();
    trace(`${stage}:start`);
    try {
      return await work();
    } finally {
      trace(`${stage}:end`, { durationMs: Math.round(performance.now() - started) });
    }
  };
  context?.onTestFailed(() => console.error("Resource wait liveness failure stages", JSON.stringify(stages)));
  trace("fixture:start");
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
  const directory = join(root, "state", "fleet-resources");
  const paneId = detachedCodex ? "w48:p5F" : "w1:p1";
  const seatId = detachedCodex ? "term_65ef24ebb035f201" : "fixture-seat";
  const binding = {
    runtime: "external" as const,
    session: "default",
    socketPath: join(root, "fixture.sock"),
  };
  let child: ChildProcess;
  let sessionId = detachedCodex ? "01a185b6-0a85-77c0-983a-eea6c1aeac32" : "fixture-original-session",
    replaced = false,
    admitted = true;
  const session = () => ({
    source: detachedCodex ? "herdr:codex" : "herdr:claude",
    kind: "id" as const,
    value: sessionId,
  });
  const durable = {
    path: join(root, "local-codex-seats.json"),
    observeOccupant: async () => occupantIdForHerdrSession(session()),
  };
  let privateSeats = new LocalCodexSeats(() => binding, undefined, durable);
  let privateProofBarrier: (() => Promise<void>) | undefined;
  const frontend = detachedCodex
    ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env, stdio: "ignore" })
    : undefined;
  if (frontend) {
    await once(frontend, "spawn");
    cleanups.push(() => stop(frontend));
  }
  const governor = createResourceGovernor({
    directory,
    probe: async () => ({ loadRatio: 0, cpuRatio: 0, availableMemoryMb: 32768 }),
    simulatorBootSettleMs: 0,
    heavyJobSettleMs: 0,
    nativeSimulatorOwner: async (owner, chain) => {
      const barrier = privateProofBarrier;
      privateProofBarrier = undefined;
      await barrier?.();
      return (
        owner.pane === paneId &&
        owner.binding?.socketPath === binding.socketPath &&
        privateSeats.allows(
          chain.map((row) => row.pid),
          paneId,
          binding,
          owner.occupantId,
        )
      );
    },
  });
  const resources = await createFleetResourceRuntime({
    governor,
    policy: async () => undefined,
    simulator: {
      clock: () => now,
      ...(detachedCodex ? { respondWithinMs: 2000 } : {}),
      adapter: createSimctlAdapter({
        run: async (args, timeout) =>
          (
            await observed("simctl", () =>
              execute(
                process.execPath,
                [resolve("packages/fleet-resources/test/fixtures/simctl.mjs"), statePath, log, ...args],
                { env, timeout },
              ),
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
  const native = async () => {
    const nativePid = frontend?.pid ?? child?.pid;
    const identity = nativePid
      ? await observed("native-process-proof", () => processIdentity(nativePid))
      : undefined;
    if (!identity) throw Error("Fixture native process unavailable");
    return {
      fleet: "default",
      pane: paneId,
      nativeOccupantId: occupantIdForHerdrSession(session()),
      binding: { socketPath: binding.socketPath, ...(detachedCodex ? { session: binding.session } : {}) },
      shell: { pid: identity.pid, startTime: identity.startTime },
      processes: [{ pid: identity.pid, startTime: replaced ? "replaced-birth" : identity.startTime }],
    };
  };
  let resolutions = 0;
  resources.bindSeats({
    isLocalFleet: async () => true,
    resolve: async (id) => {
      resolutions += 1;
      return [paneId, seatId].includes(id)
        ? {
            terminalId: seatId,
            paneId,
            agent: detachedCodex ? "codex" : "claude",
            status: "working",
            title: "Native fixture",
            session: session(),
          }
        : undefined;
    },
    proof: async () => native(),
  });
  // Real TCP kernel ownership and native birth/ancestry. Only harness discovery
  // is a surrogate: the server pins this fixture process as its native seat.
  const socketOwners = new WeakMap<Socket, number>();
  let measureAdmissionCpu = false,
    admissionCpuMs = 0;
  const prove = async (socket: Socket, pane: string) => {
    if (!admitted || pane !== paneId || socket.destroyed) return false;
    let pid = socketOwners.get(socket);
    if (!pid) {
      const args = ["-nP", "-iTCP", "-Fpn"];
      const output = await observed("admission-lsof", () =>
        measureAdmissionCpu
          ? execute("/usr/bin/time", ["-p", "/usr/sbin/lsof", ...args])
          : execute("/usr/sbin/lsof", args),
      );
      if (measureAdmissionCpu)
        for (const match of output.stderr.matchAll(/^(?:user|sys) ([0-9.]+)$/gm))
          admissionCpuMs += Number(match[1]) * 1000;
      pid = clientPid(output.stdout, socket.remotePort!, socket.localPort!);
      if (!pid) return false;
      socketOwners.set(socket, pid);
    }
    const holder = await native().catch(() => undefined);
    if (detachedCodex) {
      const chain: number[] = [];
      for (
        let current = await processIdentity(pid);
        current && chain.length < 64;
        current = await processIdentity(current.ppid)
      ) {
        chain.push(current.pid);
        if (current.ppid <= 1) break;
      }
      return privateSeats.allows(chain, paneId, binding, holder?.nativeOccupantId);
    }
    // time(1) is an optional measurement parent; admission still requires exact
    // live ancestry to this fixture's pinned native process and birth.
    for (let current = await processIdentity(pid), depth = 0; current && depth < 5; depth += 1) {
      if (current.pid === child.pid) return current.startTime === holder?.processes[0]!.startTime;
      current = await processIdentity(current.ppid);
    }
    return false;
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
  let hookBarrier = Promise.resolve();
  let hookEntered = () => {};
  let requestBarrier = Promise.resolve();
  app.use("/v1/fleet/seats/:paneId/hook", async (context, next) => {
    const body = await context.req.json();
    await requestBarrier;
    if (legacy) {
      if (body.occurredAt !== undefined || body.agentId !== undefined || body.event === "PostToolUse")
        return context.json({ error: "invalid_request" }, 400);
    }
    hooks.push(body);
    await next();
  });
  registerSeatRoutes({
    app,
    dependencies: {
      captain: {
        ...createStubCaptain(),
        recordSeatHook: async () => {
          hookEntered();
          await hookBarrier;
          return true;
        },
      },
      fleetResources: resources,
      localFleet: link,
    },
    authenticateLane: async (context) =>
      context.req.header("authorization") === "Bearer fixture-owner"
        ? { lane: "operator" }
        : { denial: Response.json({ error: "operator_required" }, { status: 403 }) },
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
      new URL(request.url).pathname.startsWith("/v1/fleet/seats/") &&
      request.headers.get("authorization") !== "Bearer fixture-owner"
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
      socket: join(root, "fixture.sock"),
      url: host,
    }),
  );
  child = spawn(process.execPath, [resolve("apps/clankie/test/fixtures/resource-activity-engine.mjs")], {
    env: {
      ...env,
      CLANKIE_STATE: join(root, "state"),
      ACTIVITY_FIXTURE_ROOT: root,
      ACTIVITY_PLUGIN_ROOT: resolve("integrations/claude-plugin/worker"),
      CLAUDE_PLUGIN_ROOT: resolve("integrations/claude-plugin/worker"),
      ACTIVITY_MOD_PATH: resolve("integrations/claude-plugin/worker/mods/tool-catalog.mjs"),
      ...(context ? { ACTIVITY_TRACE: "1" } : {}),
      HERDR_PANE_ID: paneId,
      HERDR_SOCKET_PATH: join(root, "fixture.sock"),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    detached: detachedCodex,
  });
  let errors = "";
  child.stderr!.on("data", (data) => {
    errors += data;
    if (context) trace("engine-stderr", { text: String(data).slice(-4000) });
  });
  cleanups.push(() => stop(child));
  trace("engine-ready:start", { pid: child.pid });
  expect((await once(child, "message"))[0], errors).toEqual({ ready: true });
  trace("engine-ready:end", { pid: child.pid });
  if (detachedCodex) {
    const registration = privateSeats.register(child.pid!, paneId);
    await registration.bindSession!(sessionId);
    // As after a service restart, only the durable original launch remains.
    privateSeats = new LocalCodexSeats(() => binding, undefined, durable);
  }
  let nextId = 0;
  const send = async (message: Record<string, unknown>) => {
    const id = ++nextId;
    trace("engine-ipc:start", { id, event: message.event, tick: message.tick });
    const reply = once(child, "message");
    child.send!({ ...message, id, now });
    const received = (await reply)[0];
    trace("engine-ipc:end", { id });
    expect(received, errors).toMatchObject({ id, ok: true });
    if (received.activityExitCode !== undefined || message.expectedActivityExit !== undefined)
      expect(received.activityExitCode, errors).toBe(message.expectedActivityExit ?? 0);
    return received;
  };
  const cli = (action: string, data: Record<string, unknown>) =>
    runSimulatorCommand([action, JSON.stringify(data)], {
      host,
      env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" },
      operatorCredentialStore: new FileCredentialStore(join(root, "credentials.json")),
    });
  const owner = { seatId, holderId: `${detachedCodex ? "codex" : "claude"}:${sessionId}` };
  const acquire = async (holderId = owner.holderId) => {
    const result = (await observed("simulator-acquire", () =>
      cli("acquire", { ...owner, holderId, deviceType, runtime }),
    )) as SimulatorResult;
    if (result.outcome !== "acquired") throw Error(JSON.stringify(result));
    return result.lease;
  };
  return {
    root,
    legacy: () => (legacy = true),
    holdRequests: () => {
      let release!: () => void;
      requestBarrier = new Promise<void>((resolve) => (release = resolve));
      cleanups.push(async () => release());
      return { release };
    },
    holdHooks: () => {
      let release!: () => void;
      const entered = new Promise<void>((resolve) => (hookEntered = resolve));
      hookBarrier = new Promise<void>((resolve) => (release = resolve));
      cleanups.push(async () => release());
      return { entered, release };
    },
    hooks: () => hooks,
    resolutions: () => resolutions,
    admissionCpu: (enabled: boolean) => {
      measureAdmissionCpu = enabled;
      const total = admissionCpuMs;
      admissionCpuMs = 0;
      return total;
    },
    hint: join(directory, "root-hook-leases", join(root, "fixture.sock"), "w1:p1"),
    host,
    directory,
    resources,
    governor,
    send,
    acquire,
    owner,
    child,
    native,
    pausePrivateProof: () => {
      let entered!: () => void, resume!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        resume = resolve;
      });
      privateProofBarrier = async () => {
        entered();
        await barrier;
      };
      return { waiting, resume };
    },
    cli,
    seatHook: (event: string) =>
      runSeatHookCommand([], {
        host,
        env: { HERDR_PANE_ID: "w1:p1", CLANKIE_OPERATOR_TOKEN: "fixture-owner" },
        operatorCredentialStore: new FileCredentialStore(join(root, "credentials.json")),
        stdin: (async function* () {
          yield JSON.stringify({
            hook_event_name: event,
            session_id: "fixture-original-session",
            tool_name: "Read",
          });
        })(),
      }),
    advance: (ms: number) => (now += ms),
    now: () => now,
    setSession: (id: string) => (sessionId = id),
    replace: (value = true) => (replaced = value),
    deny: () => (admitted = false),
    allow: () => (admitted = true),
    devices: async () => JSON.parse(await readFile(statePath, "utf8")),
  };
}

it.skipIf(process.platform !== "darwin")(
  "original-native child retention crosses the old-evidence and idle windows; root and prompt deadlines still expire",
  async (context) => {
    const f = await fixture(context);
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
    expect(next.id).not.toBe(lease.id);
  },
  30_000,
);

it.skipIf(process.platform !== "darwin")(
  "original-native child refusal, replay, session replacement and process exit cannot retain a lease",
  async (context) => {
    const f = await fixture(context);
    await f.send({ event: "session.start", input: { isInteractive: true } });
    const childId = "a1111111111111111";
    const childHolder = `${f.owner.holderId}:agent:${childId}`;
    await f.acquire(childHolder);
    await f.send({
      children: [{ id: childId, type: "general-purpose", status: "running" }],
      event: "turn.start",
      input: { turnId: "second", agentId: childId },
      tick: true,
    });
    f.deny();
    await f.send({ tick: true, expectedActivityExit: 1 });
    // This manual report starts a fresh producer instance, as it did after the
    // long retention phase before these independent scenarios were split.
    f.advance(1);
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
  30_000,
);

it.skipIf(process.platform !== "darwin").each(["root", "child", "codex", "detached-codex"])(
  "exact native holder heavy queue and permit retain the lease; copied labels outside its process ancestry do not (%s)",
  async (scope) => {
    const f = await fixture(undefined, scope === "detached-codex");
    if (scope === "detached-codex") expect((await f.native()).processes[0]!.pid).not.toBe(f.child.pid);
    if (scope === "child") f.owner.holderId += ":agent:a3333333333333333";
    if (scope === "codex") f.owner.holderId = "codex:fixture-original-session";
    if (scope !== "detached-codex") await f.send({ event: "session.start", input: { isInteractive: true } });
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
    await f.send({
      heavy: "start",
      directory: f.directory,
      release,
      holderId: f.owner.holderId,
      seatId: scope === "detached-codex" ? "w48:p5F" : "w1:p1",
    });
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
  "a slow original Codex server membership proof does not block simulator release",
  async () => {
    const f = await fixture(undefined, true);
    const lease = await f.acquire();
    await f.send({
      heavy: "start",
      directory: f.directory,
      release: join(f.root, "private-release"),
      holderId: f.owner.holderId,
      seatId: "w48:p5F",
    });
    cleanups.push(() => f.send({ heavy: "stop" }));
    await f.send({ heavy: "ready" });
    const paused = f.pausePrivateProof();
    const ticking = f.resources.simulators.tick();
    await paused.waiting;
    try {
      expect(await f.cli("release", { ...f.owner, id: lease.id })).toEqual({ outcome: "released" });
    } finally {
      paused.resume();
      await ticking;
    }
    expect(await f.governor.simulatorReservations()).toEqual([]);
  },
);

it.skipIf(process.platform !== "darwin")(
  "a delayed membership result cannot renew heavy work that already completed",
  async () => {
    const f = await fixture(undefined, true);
    await f.acquire();
    await f.send({
      heavy: "start",
      directory: f.directory,
      release: join(f.root, "delayed-private-release"),
      holderId: f.owner.holderId,
      seatId: "w48:p5F",
    });
    cleanups.push(() => f.send({ heavy: "stop" }));
    await f.send({ heavy: "ready" });
    const paused = f.pausePrivateProof();
    const ticking = f.resources.simulators.tick();
    await paused.waiting;
    try {
      await f.send({ heavy: "stop" });
      expect(
        (await f.governor.snapshot()).leases.filter(
          (row) => row.kind === "heavy" && row.holderId === f.owner.holderId,
        ),
      ).toEqual([]);
      f.advance(600_001);
    } finally {
      paused.resume();
      await ticking;
    }
    expect(await f.governor.simulatorReservations()).toEqual([]);
  },
);

it.skipIf(process.platform !== "darwin")(
  "a pane-labelled Codex server permit retains its simulator, then idle still expires",
  async () => {
    const f = await fixture();
    f.owner.holderId = "codex:fixture-original-session";
    const lease = await f.acquire();
    await f.send({
      heavy: "start",
      directory: f.directory,
      release: join(f.root, "server-release"),
      holderId: f.owner.holderId,
      seatId: "w1:p1",
      server: true,
    });
    cleanups.push(() => f.send({ heavy: "stop" }));
    await f.send({ heavy: "ready" });
    expect((await f.governor.snapshot()).serverLeases).toContainEqual(
      expect.objectContaining({ holderId: f.owner.holderId, seatId: "w1:p1" }),
    );
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
    const originalDeadline = (await f.governor.simulatorReservations())[0]!.lastUsedAtMs;
    // An old plugin remains admitted but missing event time never buys renewal.
    for (const event of ["UserPromptSubmit", "PreToolUse"]) {
      const oldHook = { schemaVersion: 1, event, sessionId: "fixture-original-session" };
      await f.send({ hook: oldHook });
      expect(f.hooks().at(-1)).toEqual(oldHook);
      expect((await f.governor.simulatorReservations())[0]!.lastUsedAtMs).toBe(originalDeadline);
    }
    expect(existsSync(f.hint)).toBe(true);
    const held = f.holdHooks();
    const pending = hook("UserPromptSubmit");
    await held.entered;
    try {
      f.advance(20_000);
      await f.resources.simulators.tick();
      expect((await f.governor.simulatorReservations()).map((row) => row.id)).toEqual([lease.id]);
    } finally {
      held.release();
      await pending;
    }
    // A replay keeps the original event deadline, not receipt time.
    await hook("UserPromptSubmit", eventAt);
    // An older in-window delivery must not shorten a newer event's deadline.
    await hook("PreToolUse");
    await hook("PostToolUse", eventAt);
    await hook("Stop");
    await hook("StopFailure");
    await hook("SessionEnd");
    f.advance(599_999);
    await f.resources.simulators.tick();
    expect(await f.governor.simulatorReservations()).toHaveLength(1);
    f.advance(1);
    await f.resources.simulators.tick();
    expect(await f.governor.simulatorReservations()).toHaveLength(0);
    expect(existsSync(f.hint)).toBe(false);
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

it.skipIf(process.platform !== "darwin")(
  "stalled ordinary tool hooks release promptly while question hooks retain their long wait",
  async () => {
    const f = await fixture();
    await f.acquire();
    f.advance(120_000);
    for (const event of ["PreToolUse", "PostToolUse"]) {
      const before = (await f.governor.simulatorReservations())[0]!.lastUsedAtMs;
      const held = f.holdRequests();
      const start = performance.now();
      try {
        const result = await f.send({
          workerHook: { hook_event_name: event, session_id: "fixture-original-session", tool_name: "Read" },
          allowHookFailure: true,
        });
        expect(result.workerHookResult.exitCode).toBe(0);
        expect(result.workerHookResult.stderr).toMatch(/timeout|timed out/iu);
        expect(performance.now() - start).toBeLessThan(5_000);
      } finally {
        held.release();
      }
      expect(existsSync(f.hint)).toBe(true);
      await f.send({
        workerHook: { hook_event_name: event, session_id: "fixture-original-session", tool_name: "Read" },
      });
      expect((await f.governor.simulatorReservations())[0]!.lastUsedAtMs).toBeGreaterThan(before);
      const heldCli = f.holdRequests();
      const cliStart = performance.now();
      try {
        await expect(f.seatHook(event)).rejects.toThrow(/timeout|timed out/iu);
        expect(performance.now() - cliStart).toBeLessThan(5_000);
      } finally {
        heldCli.release();
      }
    }
    const held = f.holdHooks();
    let settled = false;
    const question = f
      .send({
        workerHook: {
          hook_event_name: "PreToolUse",
          session_id: "fixture-original-session",
          tool_name: "AskUserQuestion",
          tool_input: { questions: [] },
        },
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await held.entered;
    try {
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      expect(settled).toBe(false);
    } finally {
      held.release();
      await question;
    }
  },
);

it.skipIf(process.platform !== "darwin")(
  "ordinary hooks skip resource ownership work without a lease and measure the real helper and HTTP route cost",
  async () => {
    const f = await fixture();
    const lease = await f.acquire();
    f.advance(120_000);
    const samples = async () => {
      const times: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const start = performance.now();
        for (const event of ["PreToolUse", "PostToolUse"])
          await f.send({
            workerHook: { hook_event_name: event, session_id: "fixture-original-session", tool_name: "Read" },
          });
        times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      return {
        samples: times.length,
        perToolP50Ms: Math.round(times[2]!),
        perToolP95Ms: Math.round(times[4]!),
      };
    };
    const observerCpu = async () => {
      const rows = (await execute("/bin/ps", ["-axo", "pid=,ppid=,time=,command="])).stdout;
      const row = rows
        .split("\n")
        .map((line) => line.trim().split(/\s+/u))
        .find(
          (fields) =>
            fields[1] === String(process.pid) &&
            fields.slice(3).join(" ").includes("/fleet-resources/src/native.py serve"),
        );
      expect(row).toBeDefined();
      return row![2]!.split(":").reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1000;
    };
    const cpu = async (ungated = false) => {
      const nativeStart = await observerCpu();
      f.admissionCpu(true);
      const start = process.cpuUsage();
      let childMs = 0;
      for (const event of ["PreToolUse", "PostToolUse"]) {
        const result = await f.send({
          workerHook: { hook_event_name: event, session_id: "fixture-original-session", tool_name: "Read" },
          measureCpu: true,
          ungated,
          allowHookFailure: true,
        });
        expect(result.workerHookResult.exitCode).toBe(0);
        const output = result.workerHookResult.stderr as string;
        for (const field of ["user", "sys"]) {
          const match = output.match(new RegExp(`^${field} ([0-9.]+)$`, "m"));
          expect(match).not.toBeNull();
          childMs += Number(match![1]) * 1000;
        }
      }
      const parent = process.cpuUsage(start);
      const admissionSubprocessCpuMs = Math.round(f.admissionCpu(false));
      const nativeObserverCpuMs = Math.round((await observerCpu()) - nativeStart);
      const serviceAndDriverCpuMs = Math.round((parent.user + parent.system) / 1000);
      return {
        helperSubtreesCpuMs: Math.round(childMs),
        serviceAndDriverCpuMs,
        admissionSubprocessCpuMs,
        nativeObserverCpuMs,
        totalCpuMs:
          Math.round(childMs) + serviceAndDriverCpuMs + admissionSubprocessCpuMs + nativeObserverCpuMs,
        childRoundingMs: 10,
      };
    };
    expect(existsSync(f.hint)).toBe(true);
    const withLease = { ...(await samples()), cpu: await cpu() };
    expect(existsSync(f.hint)).toBe(true);
    await f.cli("release", { ...f.owner, id: lease.id });
    expect(existsSync(f.hint)).toBe(false);
    expect(await f.governor.simulatorReservations()).toHaveLength(0);
    const before = f.resolutions();
    const requestCount = f.hooks().length;
    const withoutLease = { ...(await samples()), cpu: await cpu() };
    expect(f.hooks()).toHaveLength(requestCount);
    expect(f.resolutions() - before).toBe(0);
    // A stale hint costs at most one helper and cannot renew a missing lease.
    await writeFile(f.hint, "claude:stale-session");
    await f.send({
      workerHook: {
        hook_event_name: "PreToolUse",
        session_id: "fixture-original-session",
        tool_name: "Read",
      },
    });
    expect(existsSync(f.hint)).toBe(false);
    const afterStale = f.hooks().length;
    await f.send({
      workerHook: {
        hook_event_name: "PostToolUse",
        session_id: "fixture-original-session",
        tool_name: "Read",
      },
    });
    expect(f.hooks()).toHaveLength(afterStale);
    const ungatedWithoutLeaseCpu = await cpu(true);
    process.stdout.write(
      JSON.stringify({
        rootHookLatency: {
          withLease,
          withoutLease,
          ungatedWithoutLeaseCpu,
          scope:
            "Each sample includes both registered shell prechecks and any Node helpers plus kernel-authenticated TCP, real route/resource manager/governor. No-lease shells finish completely (a conservative bound on async blocking launch); CPU is a separate one-pair sample, time -p child/helper/admission CPU and ps native-observer CPU rounded to 10ms, plus service/driver process CPU. Ungated no-lease CPU invokes the previous Node command for comparison. Native discovery and simulator adapter are surrogates; ordinary hooks bypass captain recording; question/lifecycle recording is a stub. Baseline without hooks has no added calls.",
        },
      }) + "\n",
    );
  },
);

it.skipIf(process.platform !== "darwin")(
  "a refused ordinary hook preserves the hint and later admitted hooks renew",
  async () => {
    const f = await fixture();
    await f.acquire();
    f.advance(120_000);
    const before = (await f.governor.simulatorReservations())[0]!.lastUsedAtMs;
    f.deny();
    await f.send({
      workerHook: {
        hook_event_name: "PreToolUse",
        session_id: "fixture-original-session",
        tool_name: "Read",
      },
      allowHookFailure: true,
    });
    expect(existsSync(f.hint)).toBe(true);
    f.allow();
    const count = f.hooks().length;
    for (let i = 0; i < 3; i += 1)
      await f.send({
        workerHook: {
          hook_event_name: "PostToolUse",
          session_id: "fixture-original-session",
          tool_name: "Read",
        },
      });
    expect(f.hooks().length - count).toBe(3);
    expect((await f.governor.simulatorReservations())[0]!.lastUsedAtMs).toBeGreaterThan(before);
  },
);

it.skipIf(process.platform !== "darwin")(
  "releasing one of two root leases preserves the hint and a later hook renews the other",
  async () => {
    const f = await fixture();
    const { policy } = await f.governor.snapshot();
    await f.governor.configure({ ...policy, simulatorSlots: 2 });
    const first = await f.acquire();
    const owner = (await f.governor.simulatorReservations())[0]!;
    const second = await f.governor.tryAcquireSimulator({
      seatId: owner.seatId,
      occupantId: owner.occupantId,
      holderId: owner.holderId!,
      fleet: owner.fleet!,
      pane: owner.pane!,
      binding: owner.binding!,
      ownerProcesses: owner.ownerProcesses!,
      deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      deviceType,
      runtime,
      externalActive: async () => 0,
    });
    expect(second.admitted).toBe(true);
    if (!second.admitted) throw Error("second lease was refused");
    await f.cli("release", { ...f.owner, id: first.id });
    expect((await f.governor.simulatorReservations()).map((lease) => lease.id)).toEqual([second.lease.id]);
    expect(existsSync(f.hint)).toBe(true);
    f.advance(120_000);
    await f.send({
      workerHook: {
        hook_event_name: "PreToolUse",
        session_id: "fixture-original-session",
        tool_name: "Read",
      },
    });
    expect((await f.governor.simulatorReservations())[0]!.lastUsedAtMs).toBeGreaterThan(
      second.lease.lastUsedAtMs,
    );
  },
);
