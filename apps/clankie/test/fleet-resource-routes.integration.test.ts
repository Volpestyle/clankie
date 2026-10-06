import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
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
async function fixture(unavailable = false) {
  const root = await mkdtemp(join(tmpdir(), "fleet-resource-http-"));
  const state = join(root, "simctl.json"),
    log = join(root, "simctl.jsonl");
  await writeFile(state, JSON.stringify({ devices: {} }));
  await writeFile(log, "");
  const directory = join(root, "governor");
  if (unavailable) await writeFile(directory, "The real native lock cannot create this directory.\n");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
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
  resources.bindSeats({
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
  const server = serve({ fetch: routes.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
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
  return {
    root,
    resources,
    send,
    commands,
    acquire: { action: "acquire", seatId: "resource-seat", deviceType, runtime: simulatorRuntime },
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
        seatId: "resource-seat",
        id: result.lease.id,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.send("POST", FLEET_SIMULATORS_PATH, {
        action: "release",
        seatId: "resource-seat",
        id: result.lease.id,
      })
    ).json,
  ).toEqual({ outcome: "released" });
  expect(
    (await f.commands())
      .filter((command) => ["create", "bootstatus", "shutdown", "delete"].includes(command[0]!))
      .map((command) => command[0]),
  ).toEqual(["create", "bootstatus", "shutdown", "delete"]);
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
