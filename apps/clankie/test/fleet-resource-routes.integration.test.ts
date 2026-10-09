import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import {
  createResourceGovernor,
  createSimctlAdapter,
  defaultResourcePolicy,
  processIdentity,
} from "@clankie/fleet-resources";
import {
  FLEET_RESOURCES_PATH,
  FLEET_SIMULATORS_PATH,
  FleetResourceSnapshotSchema,
  FleetSimulatorResultSchema,
  FleetSimulatorStatusSchema,
} from "@clankie/protocol";
import { createFleetResourceRoutes } from "../src/fleet-resource-routes.ts";
import { createFleetResourceRuntime } from "../src/fleet-resource-runtime.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { runSimulatorCommand } from "../../tui/src/command/fleet-resources.ts";
import { FileCredentialStore } from "@clankie/credential-broker";

const execute = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const simulatorRuntime = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
const deviceType = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
const bearer = "fixture-secret-owner-bearer";
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  await closed;
}
function barrier() {
  let entered!: () => void, resume!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  return {
    waiting,
    resume,
    pause: async () => {
      entered();
      await gate;
    },
  };
}
async function fixture(
  unavailable = false,
  extra: { seatScript?: string; bind?: boolean; replyLease?: Record<string, string> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "fleet-resource-http-"));
  const state = join(root, "simctl.json"),
    log = join(root, "simctl.jsonl");
  await writeFile(state, JSON.stringify({ devices: {} }));
  await writeFile(log, "");
  const directory = join(root, "governor");
  if (unavailable) await writeFile(directory, "The real native lock cannot create this directory.\n");
  const child = spawn(process.execPath, ["-e", extra.seatScript ?? "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  await once(child, "spawn");
  const native = await processIdentity(child.pid!);
  if (!native) throw new Error("Actual fixture native process unavailable");
  const session = { source: "herdr:opencode", kind: "id" as const, value: "ses_httpResourceFixture123" };
  const occupantId = occupantIdForHerdrSession(session);
  const agent = () => ({
    paneId: "w1:p1",
    terminalId: "resource-seat",
    agent: "opencode",
    status: "working",
    title: "HTTP fixture",
    session,
  });
  let authorized = true;
  let proofAction = async () => {};
  let inventoryAction = async () => {};
  const notices: { pane: string; text: string }[] = [];
  const resources = await createFleetResourceRuntime({
    governor: createResourceGovernor({
      directory,
      probe: async () => ({ loadRatio: 0.1, availableMemoryMb: 32768 }),
    }),
    policy: async () => ({ ...defaultResourcePolicy(), heavySlots: 2 }),
    simulator: {
      adapter: createSimctlAdapter({
        run: async (args, timeout) => {
          const result = await execute(
            process.execPath,
            [
              fileURLToPath(
                new URL("../../../packages/fleet-resources/test/fixtures/simctl.mjs", import.meta.url),
              ),
              state,
              log,
              ...args,
            ],
            { timeout, encoding: "utf8" },
          );
          if (args[0] === "list") await inventoryAction();
          return result.stdout;
        },
      }),
    },
  });
  if (extra.bind !== false)
    resources.bindSeats({
      notify: async (pane, text) => {
        notices.push({ pane, text });
        return true;
      },
      resolve: async (seatId) => (seatId === "resource-seat" ? agent() : undefined),
      isLocalFleet: async (fleet) => fleet === undefined || fleet === "default",
      proof: async () => {
        const current = await processIdentity(child.pid!);
        if (!current || current.startTime !== native.startTime) return undefined;
        await proofAction();
        return {
          fleet: "default",
          pane: "w1:p1",
          nativeOccupantId: occupantId,
          binding: { socketPath: join(root, "fixture-secret-socket") },
          processes: [{ pid: current.pid, startTime: current.startTime }],
          shell: { pid: current.pid, startTime: current.startTime },
        };
      },
    });
  const routes = createFleetResourceRoutes(async (incoming) => {
    const header = incoming.headers.get("authorization");
    if (!header) return "authentication_required";
    return authorized && header === `Bearer ${bearer}` ? true : "forbidden";
  }, resources);
  const server = serve({
    fetch: async (incoming) => {
      const response = await routes.fetch(incoming);
      if (extra.replyLease && incoming.method === "POST" && response.ok) {
        const body = await response.clone().json();
        if (body.outcome === "acquired")
          return new Response(JSON.stringify({ ...body, lease: { ...body.lease, ...extra.replyLease } }), {
            status: response.status,
            headers: response.headers,
          });
      }
      return response;
    },
    port: 0,
    hostname: "127.0.0.1",
  }) as Server;
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing actual HTTP listener");
  const send = (method: string, path: string, body?: unknown, token: string | null = bearer) =>
    new Promise<{ status: number; text: string; json: unknown; cache: string | undefined }>(
      (resolve, reject) => {
        const encoded =
          body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
        const call = request(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path,
            method,
            agent: false,
            headers: {
              ...(token === null ? {} : { authorization: `Bearer ${token}` }),
              ...(encoded === undefined
                ? {}
                : {
                    "content-type": "application/json",
                    "content-length": String(Buffer.byteLength(encoded)),
                  }),
            },
            timeout: 10_000,
          },
          (response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              text += chunk;
            });
            response.on("end", () => {
              let json: unknown;
              try {
                json = JSON.parse(text);
              } catch {
                json = text;
              }
              resolve({ status: response.statusCode!, text, json, cache: response.headers["cache-control"] });
            });
          },
        );
        call.on("error", reject);
        call.on("timeout", () => call.destroy(new Error("Owned HTTP test timed out")));
        call.end(encoded);
      },
    );
  const commands = async (): Promise<string[][]> =>
    (await readFile(log, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await resources.close();
    await stop(child);
    await rm(root, { recursive: true, force: true });
  });
  const mutate = async (change: (value: { devices: Record<string, unknown[]> }) => void) => {
    const value = JSON.parse(await readFile(state, "utf8"));
    change(value);
    await writeFile(state, JSON.stringify(value));
  };
  return {
    root,
    log,
    host: `http://127.0.0.1:${address.port}`,
    child,
    notices,
    mutate,
    resources,
    send,
    commands,
    acquire: {
      action: "acquire",
      seatId: "resource-seat",
      holderId: "root-task",
      deviceType,
      runtime: simulatorRuntime,
    },
    revoke: () => {
      authorized = false;
    },
    pauseProof: () => {
      const gate = barrier();
      proofAction = gate.pause;
      return gate;
    },
    pauseInventory: () => {
      const gate = barrier();
      let used = false;
      inventoryAction = async () => {
        if (!used) {
          used = true;
          await gate.pause();
        }
      };
      return gate;
    },
    failProof: () => {
      proofAction = async () => {
        throw new Error(`fixture-secret-provider-error ${root}`);
      };
    },
  };
}
function metadataOnly(text: string, privateRoot: string) {
  for (const secret of [
    bearer,
    privateRoot,
    "fixture-secret",
    '"token"',
    '"binding"',
    '"processes"',
    '"ownerProcesses"',
    '"startTime"',
    '"socketPath"',
  ])
    expect(text).not.toContain(secret);
}

it("denies unauthenticated/foreign callers before any resource or native mutation", async () => {
  const f = await fixture();
  const missing = await f.send("GET", FLEET_RESOURCES_PATH, undefined, null);
  expect(missing).toMatchObject({
    status: 401,
    json: { error: "authentication_required" },
    cache: "no-store",
  });
  const foreign = await f.send("POST", FLEET_SIMULATORS_PATH, f.acquire, "wrong-owner");
  expect(foreign).toMatchObject({ status: 403, json: { error: "forbidden" } });
  expect(await f.commands()).toEqual([]);
});

it("returns503 on real native registry unavailability without exposing its path or error", async () => {
  const f = await fixture(true);
  const response = await f.send("GET", FLEET_RESOURCES_PATH);
  expect(response).toMatchObject({ status: 503, json: { error: "fleet_resources_unavailable" } });
  metadataOnly(response.text, f.root);
  expect(await f.commands()).toEqual([]);
});

it("serves validated metadata and crosses actual TCP/governor/process-based simulator effects", async () => {
  const f = await fixture();
  const status = await f.send("GET", FLEET_RESOURCES_PATH);
  expect(status.status).toBe(200);
  expect(FleetResourceSnapshotSchema.safeParse(status.json).success).toBe(true);
  metadataOnly(status.text, f.root);
  const acquired = await f.send("POST", FLEET_SIMULATORS_PATH, f.acquire);
  expect(acquired.status).toBe(200);
  const result = FleetSimulatorResultSchema.parse(acquired.json);
  expect(result.outcome).toBe("acquired");
  if (!("lease" in result)) throw new Error("Actual fixture lease missing");
  metadataOnly(acquired.text, f.root);
  const leases = await f.send("GET", FLEET_SIMULATORS_PATH);
  expect(FleetSimulatorStatusSchema.parse(leases.json).leases).toHaveLength(1);
  metadataOnly(leases.text, f.root);
  expect(
    (
      await f.send("POST", FLEET_SIMULATORS_PATH, {
        action: "touch",
        holderId: f.acquire.holderId,
        seatId: "resource-seat",
        id: result.lease.id,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.send("POST", FLEET_SIMULATORS_PATH, {
        action: "release",
        holderId: f.acquire.holderId,
        seatId: "resource-seat",
        id: result.lease.id,
      })
    ).json,
  ).toEqual({ outcome: "released" });
  expect(
    (await f.commands())
      .filter((command) => ["create", "bootstatus", "shutdown", "delete"].includes(command[0]!))
      .map((command) => command[0]),
  ).toEqual(["create", "bootstatus", "shutdown"]);
});

it.each([
  { occupantId: "caller-claimed-native" },
  { processes: [{ pid: 2, startTime: "claimed" }] },
  { binding: { socketPath: "/caller-socket" } },
])("rejects caller kernel/occupant authority %j", async (extra) => {
  const f = await fixture();
  const response = await f.send("POST", FLEET_SIMULATORS_PATH, { ...f.acquire, ...extra });
  expect(response).toMatchObject({ status: 400, json: { error: "malformed_simulator_request" } });
  expect(await f.commands()).toEqual([]);
});

it("rejects malformed JSON, unknown actions and oversized bodies before native effects", async () => {
  const f = await fixture();
  for (const body of ["{", { ...f.acquire, action: "shutdown-all" }])
    expect((await f.send("POST", FLEET_SIMULATORS_PATH, body)).status).toBe(400);
  expect((await f.send("POST", FLEET_SIMULATORS_PATH, "x".repeat(16 * 1024 + 1))).status).toBe(413);
  expect(await f.commands()).toEqual([]);
});

it("rechecks owner authority after an awaited real native seat proof", async () => {
  const f = await fixture();
  const gate = f.pauseProof();
  try {
    const pending = f.send("POST", FLEET_SIMULATORS_PATH, f.acquire);
    await gate.waiting;
    f.revoke();
    gate.resume();
    expect(await pending).toMatchObject({ status: 403, json: { error: "forbidden" } });
    expect(await f.commands()).toEqual([]);
  } finally {
    gate.resume();
  }
});

it("rechecks owner authority after actual simulator inventory before Create", async () => {
  const f = await fixture();
  const gate = f.pauseInventory();
  try {
    const pending = f.send("POST", FLEET_SIMULATORS_PATH, f.acquire);
    await gate.waiting;
    f.revoke();
    gate.resume();
    expect((await pending).status).toBe(409);
    expect((await f.commands()).some((command) => command[0] === "create")).toBe(false);
  } finally {
    gate.resume();
  }
});

it("sanitizes native proof errors instead of returning private diagnostics", async () => {
  const f = await fixture();
  f.failProof();
  const response = await f.send("POST", FLEET_SIMULATORS_PATH, f.acquire);
  expect(response).toMatchObject({ status: 409, json: { outcome: "rejected", reason: "owner_unavailable" } });
  metadataOnly(response.text, f.root);
});

it("answers service_restarting (503) while seat proof is not bound, not owner_unavailable", async () => {
  const f = await fixture(false, { bind: false });
  const response = await f.send("POST", FLEET_SIMULATORS_PATH, f.acquire);
  expect(response).toMatchObject({
    status: 503,
    json: { outcome: "rejected", reason: "service_restarting" },
  });
  expect(await f.commands()).toEqual([]);
});

it("names a hand-booted simulator, the seat whose process uses it, and tells that seat's lead; the CLI waits with progress", async () => {
  const udid = randomUUID().toUpperCase();
  // The seat's own process starts a tool that names the device, as xcodebuild
  // or a test runner would. The native helper finds it by its arguments.
  const f = await fixture(false, {
    seatScript: `require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => { if (process.ppid === 1) process.exit(); }, 200)", "--udid=${udid}"], { stdio: "ignore" }); setInterval(() => {}, 1000);`,
  });
  await f.mutate((value) => {
    value.devices[simulatorRuntime] = [
      {
        udid,
        name: `large-screen-${udid.slice(0, 8)}`,
        state: "Booted",
        isAvailable: true,
        deviceTypeIdentifier: deviceType,
      },
    ];
  });
  await f.resources.observeSeats([{ seatId: "resource-seat", status: "working", paneId: "w1:p1" }]);
  const status = FleetSimulatorStatusSchema.parse((await f.send("GET", FLEET_SIMULATORS_PATH)).json);
  expect(status.externalActive).toBe(1);
  expect(status.external?.[0]).toMatchObject({
    udid,
    holders: [expect.objectContaining({ seatId: "resource-seat", pane: "w1:p1", executable: "node" })],
  });
  metadataOnly(JSON.stringify(status), f.root);
  await f.resources.noticeExternalSimulators();
  await f.resources.noticeExternalSimulators();
  expect(f.notices).toHaveLength(1);
  expect(f.notices[0]).toMatchObject({ pane: "w1:p1" });
  expect(f.notices[0]!.text).toContain(udid);

  const progress: string[] = [];
  const options = {
    host: f.host,
    env: { HOME: f.root, CLANKIE_OPERATOR_TOKEN: bearer },
    operatorCredentialStore: new FileCredentialStore(join(f.root, "credentials.json")),
    progress: (line: string) => progress.push(line),
  };
  let acquirePosts = 0;
  const originalFetch = fetch;
  const pending = runSimulatorCommand(["acquire", JSON.stringify(f.acquire), "--wait", "30"], {
    ...options,
    fetchImpl: async (url, init) => {
      if (init?.body && JSON.parse(String(init.body)).action === "acquire") acquirePosts++;
      return originalFetch(url, init);
    },
  });
  void pending.catch(() => undefined);
  const deadline = Date.now() + 10_000;
  let ticket: ReturnType<typeof FleetResourceSnapshotSchema.parse>["queue"][number] | undefined;
  while (Date.now() < deadline) {
    await f.resources.refresh();
    ticket = f.resources.status()?.queue.find((entry) => entry.kind === "simulator");
    if (ticket) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(ticket).toMatchObject({ holderId: f.acquire.holderId, deviceId: udid, position: 1 });
  // The owner shuts the device down while the same CLI request remains blocked.
  await f.mutate((value) => {
    (value.devices[simulatorRuntime]![0] as { state: string }).state = "Shutdown";
  });
  const result = FleetSimulatorResultSchema.parse(await pending);
  expect(acquirePosts).toBe(1);
  // The freed device is the exact idle type, so it is leased instead of creating one.
  expect(result).toMatchObject({ outcome: "acquired", lease: { deviceId: udid, origin: "existing" } });
  expect((await f.commands()).some((command) => command[0] === "create")).toBe(false);
});

it("plans through authenticated HTTP and the CLI warns before submitting a new device effect", async () => {
  const f = await fixture();
  const input = { ...f.acquire, action: "plan" };
  const rejected = await f.send("POST", FLEET_SIMULATORS_PATH, input, "wrong-owner");
  expect(rejected.status).toBe(403);
  expect(await f.commands()).toEqual([]);
  const planned = await f.send("POST", FLEET_SIMULATORS_PATH, input);
  expect(FleetSimulatorResultSchema.parse(planned.json)).toEqual({
    outcome: "planned",
    choice: "create",
    simulatorIdleMs: 600000,
  });
  expect((await f.resources.simulators.snapshot()).leases).toEqual([]);
  expect((await f.commands()).filter((command) => command[0] !== "list")).toEqual([]);
  const progress: string[] = [];
  let effectsAtWarning: string[][] | undefined;
  const result = await runSimulatorCommand(["acquire", JSON.stringify(f.acquire)], {
    host: f.host,
    env: { CLANKIE_OPERATOR_TOKEN: bearer },
    progress: (line) => {
      progress.push(line);
      if (line.includes("first boot is expensive"))
        effectsAtWarning = readFileSync(f.log, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((row) => JSON.parse(row))
          .filter((command) => command[0] !== "list");
    },
  });
  expect(result).toMatchObject({ outcome: "acquired" });
  expect(effectsAtWarning).toEqual([]);
  expect(progress.some((line) => line.includes("touch the lease"))).toBe(true);
  expect((await f.commands()).filter((command) => command[0] === "create")).toHaveLength(1);
});

it("Claude Bash hook child IDs survive the CLI, verified seat, HTTP and journal boundaries", async () => {
  const f = await fixture();
  const credentials = new FileCredentialStore(join(f.root, "credentials.json"));
  const hook = async (agentId: string, worker: boolean) => {
    const pluginRoot = fileURLToPath(
      new URL(
        worker ? "../../../integrations/claude-plugin/worker/" : "../../../integrations/claude-plugin/",
        import.meta.url,
      ),
    );
    const config = JSON.parse(await readFile(join(pluginRoot, "hooks/hooks.json"), "utf8"));
    const command = config.hooks.PreToolUse.find((entry: { matcher: string }) => entry.matcher === "Bash")
      .hooks[0].command;
    const child = spawn("/bin/sh", ["-c", command], {
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (bytes) => (output += String(bytes)));
    const done = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    child.stdin.end(
      JSON.stringify({
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        session_id: "parent",
        agent_id: agentId,
        tool_input: {
          command: "node -e 'process.stdout.write(process.env.CLANKIE_RESOURCE_HOLDER)'",
          timeout: 10000,
        },
      }),
    );
    expect(await done).toBe(0);
    const result = JSON.parse(output).hookSpecificOutput;
    expect(result.permissionDecision).toBeUndefined();
    expect(result.updatedInput.timeout).toBe(10000);
    const { stdout } = await execute(
      "/bin/sh",
      [
        "-c",
        result.updatedInput.command +
          '\nnode -e \'process.stdout.write("|"+process.env.CLANKIE_RESOURCE_HOLDER+"|"+process.env.CODEX_THREAD_ID)\'',
      ],
      {
        env: { ...process.env, CLANKIE_RESOURCE_HOLDER: "parent-holder", CODEX_THREAD_ID: "ancestor-thread" },
      },
    );
    expect(stdout.endsWith("|parent-holder|ancestor-thread")).toBe(true);
    return stdout.split("|")[0]!;
  };
  const holderIds = await Promise.all([hook("dock", false), hook("cards", true)]);
  expect(holderIds).toEqual(["claude:parent:agent:dock", "claude:parent:agent:cards"]);
  const options = (holderId: string) => ({
    host: f.host,
    operatorCredentialStore: credentials,
    env: { CLANKIE_OPERATOR_TOKEN: bearer, CLANKIE_RESOURCE_HOLDER: holderId },
  });
  const { holderId: _holder, ...nativeAcquire } = f.acquire;
  const results = await Promise.all(
    holderIds.map((id) =>
      runSimulatorCommand(["acquire", JSON.stringify(nativeAcquire), "--wait", "0"], options(id)).then(
        FleetSimulatorResultSchema.parse,
      ),
    ),
  );
  expect(results.map((result) => result.outcome).sort()).toEqual(["acquired", "waiting"]);
  const acquired = results.find((result) => result.outcome === "acquired");
  if (!acquired || !("lease" in acquired)) throw new Error("Missing acquired child lease");
  const winner = acquired.lease.holderId!;
  const loser = holderIds.find((id) => id !== winner)!;
  const verification = JSON.stringify({
    seatId: "resource-seat",
    id: acquired.lease.id,
    deviceId: acquired.lease.deviceId,
  });
  expect(await runSimulatorCommand(["verify", verification], options(loser))).toMatchObject({
    outcome: "rejected",
    reason: "stale_owner",
  });
  expect(await runSimulatorCommand(["verify", verification], options(winner))).toMatchObject({
    outcome: "acquired",
    lease: { id: acquired.lease.id, holderId: winner },
  });
  await f.resources.refresh();
  const snapshot = FleetResourceSnapshotSchema.parse((await f.send("GET", FLEET_RESOURCES_PATH)).json);
  expect(snapshot.leases[0]).toMatchObject({ seatId: "resource-seat", holderId: winner });
  expect(snapshot.capacity).toMatchObject({ used: 0, simulatorUsed: 1 });
  const released = await runSimulatorCommand(
    ["release", JSON.stringify({ seatId: "resource-seat", id: acquired.lease.id })],
    options(loser),
  );
  expect(released).toMatchObject({ outcome: "rejected", reason: "stale_owner" });
  expect(
    await runSimulatorCommand(
      ["release", JSON.stringify({ seatId: "resource-seat", id: acquired.lease.id })],
      options(winner),
    ),
  ).toMatchObject({ outcome: "released" });
});

it.each([
  { deviceId: "11111111-1111-4111-8111-111111111111" },
  { holderId: "sibling-holder" },
  { deviceType: "com.apple.CoreSimulator.SimDeviceType.iPad-Air-11-inch-M4" },
  { runtime: "com.apple.CoreSimulator.SimRuntime.iOS-26-0" },
])("CLI rejects a mismatched successful native HTTP grant: %j", async (replyLease) => {
  const f = await fixture(false, { replyLease });
  const deviceId = "22222222-2222-4222-8222-222222222222";
  await f.mutate((value) => {
    value.devices[simulatorRuntime] = [
      {
        udid: deviceId,
        name: "Requested iPhone",
        state: "Shutdown",
        isAvailable: true,
        deviceTypeIdentifier: deviceType,
      },
    ];
  });
  await expect(
    runSimulatorCommand(
      ["acquire", JSON.stringify({ ...f.acquire, holderId: "requested-holder", deviceId, exact: true })],
      {
        host: f.host,
        env: { CLANKIE_OPERATOR_TOKEN: bearer, CLANKIE_RESOURCE_HOLDER: "requested-holder" },
      },
    ),
  ).rejects.toThrow("Simulator grant does not match this holder/device request");
  expect((await f.commands()).some((command) => command[0] === "shutdown")).toBe(false);
});
