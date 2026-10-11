import { runMachineResourceStatusCommand } from "../../tui/src/command/fleet-resources.ts";
import { formatFleetLines, runFleetCommand } from "../../tui/src/command/fleet.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import {
  FleetResourcePolicySchema,
  resolveFleetResourcePolicy,
  FleetResourceSnapshotSchema,
} from "@clankie/protocol";
import { createResourceGovernor } from "@clankie/fleet-resources";
import { ClankieApiClient } from "../../../packages/api-client/src/index.ts";
import { createMachineFleetResources } from "../src/machine-fleet-resources.ts";
import { createServiceFleetResourceRuntime } from "../src/service-fleet-resources.ts";
import { createFleetResourceRoutes } from "../src/fleet-resource-routes.ts";
import { createFleetSettingsRoutes } from "../src/fleet-settings-routes.ts";

it("the real settings/API/client keeps host policies and observations separate, including offline machines", async () => {
  const root = await mkdtemp(join(tmpdir(), "machine-resources-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    machines: [
      { id: "other", ssh: "other.invalid", shell: "posix", aliases: [] },
      { id: "offline", ssh: "offline.invalid", shell: "powershell", aliases: [] },
    ],
    fleet: {
      ...current.fleet,
      resources: FleetResourcePolicySchema.parse({ heavySlots: 2, simulatorSlots: 0 }),
    },
  }));
  const hostGovernor = await createResourceGovernor({ directory: join(root, "other") });
  const local = await createServiceFleetResourceRuntime(
    { policy: async () => (await settings.load()).fleet.resources },
    { NODE_ENV: "test", CLANKIE_TEST_FLEET_RESOURCES_DIRECTORY: join(root, "local") },
  );
  await local.refresh();
  const specs = { platform: "linux" as const, cores: 16, memoryBytes: 64 * 1024 ** 3 };
  let reportedMachine = "other";
  const host = new Hono();
  host.get("/status", async (context) =>
    context.json({ machine: reportedMachine, specs, snapshot: await hostGovernor.snapshot() }),
  );
  host.post("/policy", async (context) => {
    await hostGovernor.configure(await context.req.json());
    return context.json({ ok: true });
  });
  const hostServer = serve({ fetch: host.fetch, hostname: "127.0.0.1", port: 0 });
  if (!hostServer.listening) await once(hostServer, "listening");
  const hostAddress = hostServer.address();
  if (!hostAddress || typeof hostAddress === "string") throw new Error("No host address");
  const hostUrl = `http://127.0.0.1:${hostAddress.port}`;
  const machines = createMachineFleetResources({
    settings: () => settings.load(),
    local,
    remote: {
      status: async (machine) =>
        machine === "other" ? (await fetch(`${hostUrl}/status`)).json() : undefined,
      configure: async (_machine, policy) => {
        const reply = await fetch(`${hostUrl}/policy`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(policy),
        });
        if (!reply.ok) throw new Error("Host policy failed");
      },
    },
  });
  const authorize = async (request: Request) =>
    request.headers.get("authorization") === "Bearer fixture-owner"
      ? (true as const)
      : ("forbidden" as const);
  const app = new Hono();
  app.route("/", createFleetResourceRoutes(authorize, local, undefined, machines));
  app.route(
    "/",
    createFleetSettingsRoutes(authorize, settings, {
      configureResources: (_policy, machine) => machines.configure(machine ?? "local"),
    }),
  );
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No API address");
  const client = new ClankieApiClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    operatorToken: "fixture-owner",
  });
  try {
    const original = await client.fleetResources();
    expect(FleetResourceSnapshotSchema.parse(original).capacity.heavySlots).toBe(2);
    const selected = await client.fleetResources("default");
    expect(selected).toMatchObject({
      machine: "local",
      status: "available",
      specs: { cores: availableParallelism(), memoryBytes: totalmem() },
      snapshot: original,
    });
    let saved = await client.fleetSettings();
    expect(saved.resourceMachines).toEqual(["local", "other", "offline"]);
    saved = await client.updateFleetSettings({
      schemaVersion: 1,
      expectedRevision: saved.revision,
      changes: { machineResources: { other: FleetResourcePolicySchema.parse({}) } },
    });
    const other = await client.fleetResources("other");
    expect(other).toMatchObject({
      machine: "other",
      status: "available",
      specs,
      snapshot: { capacity: { heavySlots: 5, simulatorSlots: 0 } },
    });
    expect((await client.fleetResources()).capacity.heavySlots).toBe(2);
    saved = await client.updateFleetSettings({
      schemaVersion: 1,
      expectedRevision: saved.revision,
      changes: { machineResources: { offline: FleetResourcePolicySchema.parse({ heavySlots: 7 }) } },
    });
    expect(saved.fleet.machineResources?.other).toEqual(FleetResourcePolicySchema.parse({}));
    expect(await client.fleetResources("offline")).toMatchObject({
      machine: "offline",
      status: "unavailable",
      reason: "governor-unavailable",
      policy: { heavySlots: 7 },
    });
    const cliOptions = {
      settings,
      env: {
        CLANKIE_OPERATOR_TOKEN: "fixture-owner",
        CLANKIE_CONTROL_PLANE_URL: `http://127.0.0.1:${address.port}`,
      },
    };
    expect(await runMachineResourceStatusCommand("offline", cliOptions)).toMatchObject({
      machine: "offline",
      status: "unavailable",
    });
    await runFleetCommand(["set", "--machine", "other", "--heavy-slots", "4"], cliOptions);
    expect(await client.fleetResources("other")).toMatchObject({ snapshot: { capacity: { heavySlots: 4 } } });
    saved = await client.fleetSettings();
    await expect(client.fleetResources("missing")).rejects.toThrow("400");
    await expect(
      client.updateFleetSettings({
        schemaVersion: 1,
        expectedRevision: saved.revision,
        changes: { machineResources: { missing: FleetResourcePolicySchema.parse({}) } },
      }),
    ).rejects.toThrow("409");
    saved = await client.updateFleetSettings({
      schemaVersion: 1,
      expectedRevision: saved.revision,
      changes: {
        machineResources: { local: FleetResourcePolicySchema.parse({ heavySlots: 3, simulatorSlots: 0 }) },
      },
    });
    expect((await client.fleetResources()).capacity.heavySlots).toBe(3);
    const localSummary = await runFleetCommand(
      ["set", "--machine", "local", "--heavy-slots", "3"],
      cliOptions,
    );
    expect(formatFleetLines(localSummary.fleet)).toContain("heavy capacity: 3 shared slots; simulators: 0");
    await runFleetCommand(["set", "--heavy-slots", "6"], cliOptions);
    expect((await client.fleetResources()).capacity.heavySlots).toBe(6);
    expect((await client.fleetSettings()).fleet.machineResources?.local?.heavySlots).toBe(6);
    expect(await client.fleetResources("other")).toMatchObject({ snapshot: { capacity: { heavySlots: 4 } } });
    reportedMachine = "local";
    expect(await client.fleetResources("other")).toMatchObject({
      machine: "other",
      status: "unavailable",
      reason: "probe-unavailable",
    });
    const denied = new ClankieApiClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      operatorToken: "wrong",
    });
    await expect(denied.fleetResources("other")).rejects.toThrow("403");
    // Published sizing examples use the host's facts, including non-macOS zero simulators.
    expect(
      resolveFleetResourcePolicy(FleetResourcePolicySchema.parse({}), {
        platform: "darwin",
        cores: 18,
        memoryBytes: 128 * 1024 ** 3,
      }),
    ).toMatchObject({ heavySlots: 9, simulatorSlots: 1 });
    expect(
      resolveFleetResourcePolicy(FleetResourcePolicySchema.parse({}), {
        platform: "win32",
        cores: 32,
        memoryBytes: 64 * 1024 ** 3,
      }),
    ).toMatchObject({ heavySlots: 5, simulatorSlots: 0 });
  } finally {
    await Promise.all([
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
      new Promise<void>((resolve, reject) =>
        hostServer.close((error) => (error ? reject(error) : resolve())),
      ),
    ]);
    await local.close();
    await hostGovernor.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
