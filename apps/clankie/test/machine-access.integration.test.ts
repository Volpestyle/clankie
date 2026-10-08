import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { MACHINE_ACCESS_LEVELS, MachineAccessRefused, machineAccessAllows } from "@clankie/protocol";
import { createBearerAuthenticator } from "../src/app.ts";
import { createMachineAccessRoutes } from "../src/machine-access-routes.ts";
import { machineAccessLevel, requireMachineAccess } from "../src/machine-access.ts";
import { machineCodingTools } from "../src/captain/machine-coding-tools.ts";
import { Machines } from "../src/machines.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { ExecutionConnections } from "../src/herdr-session.ts";
import { machineDoctorCommand, formatMachineDoctorSummary } from "../../tui/src/command/doctor.ts";
import { runMachinesCommand } from "../../tui/src/command/machines.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-machine-access-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const settings = new SettingsStore(join(root, "settings.json"));
  const machines = new Machines({ settings, primary: () => undefined, changed: () => {} });
  await machines.add({ id: "pc", ssh: "owned-fixture.invalid", shell: "posix" });
  const token = randomUUID();
  const app = createMachineAccessRoutes({
    machines,
    authenticateOperator: createBearerAuthenticator(token, { operatorId: "owner" }),
  });
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => {
    if (server.listening) resolve();
    else server.once("listening", resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        if ("closeAllConnections" in server) server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No owned HTTP listener");
  const host = `http://127.0.0.1:${address.port}`;
  const set = (id: string, level: string) =>
    runMachinesCommand(["access", id, level], { host, env: { CLANKIE_OPERATOR_TOKEN: token } });
  return { root, settings, machines, host, set, token };
}

it("real owner API/CLI persists four levels, denies unknown or unauthenticated grants and keeps the local upgrade default", async () => {
  const f = await fixture();
  expect(machineAccessLevel(await f.settings.load(), "local")).toBe("screen");
  expect(machineAccessLevel(await f.settings.load(), "pc")).toBe("portal");
  for (const accessLevel of MACHINE_ACCESS_LEVELS) {
    expect(await f.set("pc", accessLevel)).toMatchObject({
      id: "pc",
      accessLevel,
      accessEnforcement: "service-preference",
    });
    expect(machineAccessLevel(await new SettingsStore(f.settings.path).load(), "pc")).toBe(accessLevel);
  }
  const denied = await fetch(`${f.host}/v1/machines/pc/access`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessLevel: "screen" }),
  });
  expect(denied.status).toBe(401);
  await expect(f.set("unknown", "screen")).rejects.toThrow("Unknown machine");
  await expect(f.set("pc", "full")).rejects.toThrow();
  expect(machineAccessLevel(await f.settings.load(), "unknown")).toBe("portal");
  expect(machineAccessAllows("full", "shell")).toBe(false);
  await f.set("pc", "workers");
  await expect(requireMachineAccess(f.settings, "pc", "shell")).rejects.toThrow(MachineAccessRefused);
  await expect(requireMachineAccess(f.settings, "pc", "screen")).rejects.toThrow("requires screen");
  await requireMachineAccess(f.settings, "pc", "workers");
});

it("native coding tools recheck current policy, refuse worker-level shell/filesystem effects and fail closed on unreadable policy", async () => {
  const f = await fixture();
  const tools = machineCodingTools(f.root, f.settings);
  const bash = tools.find((tool) => tool.name === "bash")!;
  await f.set("local", "workers");
  await expect(bash.execute("denied", { command: "printf forbidden > marker.txt" })).rejects.toThrow(
    "requires shell",
  );
  for (const tool of tools.filter((tool) => tool.name !== "bash"))
    await expect(tool.execute("denied", { path: "marker.txt", content: "forbidden" })).rejects.toThrow(
      "requires shell",
    );
  await expect(stat(join(f.root, "marker.txt"))).rejects.toThrow();
  await f.set("local", "shell");
  await bash.execute("allowed", { command: "printf allowed > marker.txt" });
  expect(await readFile(join(f.root, "marker.txt"), "utf8")).toBe("allowed");
  await f.set("local", "portal");
  await expect(bash.execute("revoked", { command: "printf overwritten > marker.txt" })).rejects.toThrow(
    "requires shell",
  );
  await writeFile(f.settings.path, "{malformed");
  await expect(bash.execute("unavailable", { command: "printf overwritten > marker.txt" })).rejects.toThrow();
  expect(await readFile(join(f.root, "marker.txt"), "utf8")).toBe("allowed");
});

it("a runtime named local cannot inherit the primary machine's full access", async () => {
  const f = await fixture();
  await f.settings.update((current) => ({
    ...current,
    execution: {
      ...current.execution,
      connections: [
        { id: "local", machine: "pc", session: "work", kind: "herdr", enabled: true, capabilities: [] },
      ],
    },
  }));
  const runtimes = new ExecutionConnections({
    settings: f.settings,
    primary: { binding: () => undefined, status: () => "disabled" },
  });
  await expect(runtimes.requireAccess("local", "workers")).rejects.toThrow("Machine pc has portal access");
  await runtimes.requireAccess("default", "screen");
});

it("portal policy refuses a real hire controller before any native launch or allocation", async () => {
  const f = await fixture();
  const runtimes = new ExecutionConnections({
    settings: f.settings,
    primary: { binding: () => undefined, status: () => "disabled" },
  });
  const path = join(f.root, "owned-watches.json");
  const watches = new HerdrWatchStore(path, {
    requireWorkerAccess: (fleet) => runtimes.requireAccess(fleet, "workers"),
  });
  cleanups.push(async () => watches.close());
  await f.set("local", "portal");
  const result = await watches.spawnSeat({
    schemaVersion: 1,
    harness: "codex",
    title: "Owned refusal",
    workingDirectory: f.root,
  });
  expect(result).toMatchObject({
    outcome: "failed",
    reason: "not_ready",
    detail: expect.stringContaining("Machine local has portal access"),
  });
  await expect(stat(`${path}.project-hires.json`)).rejects.toThrow();
  expect(
    await watches.moveSeat({
      seatId: "unknown-owned-seat",
      subject: "Owned refusal",
      harness: "codex",
      title: "Owned refusal",
      workingDirectory: f.root,
    }),
  ).toMatchObject({
    outcome: "failed",
    reason: "not_ready",
    detail: expect.stringContaining("has portal access"),
  });
  expect(await watches.deliverToSeat("unknown-owned-seat", "Do work")).toMatchObject({
    outcome: "undelivered",
    deliveryStage: "rejected",
    detail: expect.stringContaining("has portal access"),
  });
});

it("real SDK registration and loadout changes retain guarded native tools without calling a model", async () => {
  const f = await fixture();
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const piSettings = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: f.root,
    agentDir: f.root,
    settingsManager: piSettings,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: f.root,
    modelRuntime: runtime,
    resourceLoader: loader,
    settingsManager: piSettings,
    sessionManager: SessionManager.inMemory(f.root),
    customTools: machineCodingTools(f.root, f.settings),
  });
  cleanups.push(async () => {
    session.dispose();
  });
  await session.bindExtensions({ mode: "print" });
  expect(session.getActiveToolNames().sort()).toEqual(["read", "bash", "edit", "write"].sort());
  expect(
    session
      .getAllTools()
      .map((tool) => tool.name)
      .sort(),
  ).toEqual(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"].sort());
  session.setActiveToolsByName(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);
  await f.set("local", "workers");
  expect(session.agent.state.tools.map((tool) => tool.name).sort()).toEqual(
    ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"].sort(),
  );
  for (const tool of session.agent.state.tools)
    await expect(
      tool.execute("denied", {
        command: "printf forbidden > marker.txt",
        path: "marker.txt",
        pattern: "*",
        content: "forbidden",
        oldText: "",
        newText: "forbidden",
      }),
    ).rejects.toThrow("requires shell");
  await expect(stat(join(f.root, "marker.txt"))).rejects.toThrow();
});

it("legacy linked fleets migrate on real disk reads and persist without raising explicit owner choices or new registrations", async () => {
  const f = await fixture();
  const existing = await f.settings.load();
  for (const machineAccess of [undefined, {}, { pc: "portal" }, { pc: "shell" }]) {
    const legacy = {
      ...existing,
      machineAccess,
      execution: {
        ...existing.execution,
        connections: [
          { id: "old-fleet", machine: "pc", session: "work", kind: "herdr", enabled: true, capabilities: [] },
        ],
      },
    };
    await writeFile(f.settings.path, JSON.stringify(legacy));
    const store = new SettingsStore(f.settings.path);
    const expected = machineAccess?.pc ?? "workers";
    expect(machineAccessLevel((await store.loadFenced()).settings, "pc")).toBe(expected);
    await requireMachineAccess(store, "pc", expected === "portal" ? "portal" : "workers");
    await store.update((current) => current);
    expect(JSON.parse(await readFile(f.settings.path, "utf8")).machineAccess.pc).toBe(expected);
    expect(machineAccessLevel(await new SettingsStore(f.settings.path).load(), "pc")).toBe(expected);
  }
  await f.machines.add({ id: "new-machine", ssh: "new-fixture.invalid", shell: "posix" });
  expect(machineAccessLevel(await f.settings.load(), "new-machine")).toBe("portal");
  expect(machineAccessLevel(await f.settings.load(), "unknown")).toBe("portal");
});

it("refused operations retain a durable owner doctor item over real HTTP/CLI, coalesce and resolve when granted", async () => {
  const f = await fixture();
  const options = { host: f.host, env: { CLANKIE_OPERATOR_TOKEN: f.token } };
  await expect(requireMachineAccess(f.settings, "pc", "workers")).rejects.toThrow(MachineAccessRefused);
  await expect(requireMachineAccess(f.settings, "pc", "workers")).rejects.toThrow(MachineAccessRefused);
  const result = (await runMachinesCommand(["access-refusals"], options)) as { refusals: unknown[] };
  expect(result.refusals).toHaveLength(1);
  expect(result.refusals[0]).toMatchObject({
    machine: "pc",
    accessLevel: "portal",
    required: "workers",
    fix: expect.stringContaining("clankie machines access pc workers"),
  });
  expect(formatMachineDoctorSummary({ machine: "pc", machineAccessRefusals: result })).toContain(
    "clankie machines access pc workers",
  );
  const doctor = await machineDoctorCommand("pc", options);
  expect(doctor.machineAccessRefusals).toEqual(result);
  expect(formatMachineDoctorSummary(doctor)).toContain("clankie machines access pc workers");
  const restarted = new Machines({
    settings: new SettingsStore(f.settings.path),
    primary: () => undefined,
    changed: () => {},
  });
  expect(await restarted.accessRefusals()).toEqual(result);
  expect((await fetch(`${f.host}/v1/machines/access-refusals`)).status).toBe(401);
  await f.set("pc", "workers");
  expect(await runMachinesCommand(["access-refusals"], options)).toEqual({ refusals: [] });
});
