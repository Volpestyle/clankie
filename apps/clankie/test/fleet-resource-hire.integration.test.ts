import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import {
  createResourceGovernor,
  defaultResourcePolicy,
  processIdentity,
  type ResourcePressureInput,
} from "@clankie/fleet-resources";
import type {
  HarnessSeatAdapter,
  PreparedSeatLaunch,
  SeatControl,
  SeatProcessIdentity,
} from "@clankie/agent-hosts";
import { createFleetResourceRuntime } from "../src/fleet-resource-runtime.ts";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";
import type { ConversationAuthority } from "../src/captain/conversation-owner.ts";
import { assertConversationAuthority } from "../src/captain/conversation-owner.ts";
import { autoHireAuthority } from "../src/captain/auto-hire-policy.ts";
import { captainTools } from "../src/captain/tools.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { LaneLog } from "../src/captain/lane-log.ts";
import { autonomyLevelFleet } from "@clankie/protocol/autonomy";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { SettingsStore } from "@clankie/settings";
import {
  configuredLeadHireProject,
  localWorkspaceProject,
  nativeHireProject,
  selectHireProject,
} from "../src/captain/project-hire-context.ts";
import type { ProjectHirePolicy } from "../src/captain/herdr-watch.ts";
import { serve } from "@hono/node-server";
import { createProjectRoutes } from "../src/project-routes.ts";
import { PersonaStore } from "../src/captain/personas.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** Existing executable native-protocol fixture: ordinary Node, no model/provider/TUI hire. */
async function fixture(projectHirePolicy?: ProjectHirePolicy) {
  const root = await mkdtemp(join(tmpdir(), "fleet-resource-hire-"));
  const executable = join(root, "native-fixture.mjs");
  await writeFile(
    executable,
    await readFile(new URL("./helpers/native-process-transport/fixture.mjs", import.meta.url)),
  );
  let sample: ResourcePressureInput = { loadRatio: 0.1, availableMemoryMb: 8192 };
  let probeFailure = false;
  let probes = 0;
  let prepareAction = async () => {};
  let probeAction = async () => {};
  const policy = { ...defaultResourcePolicy(), heavySlots: 1 };
  const governor = createResourceGovernor({
    directory: join(root, "governor"),
    probe: async () => {
      probes++;
      await probeAction();
      if (probeFailure) throw new Error("sensor unavailable");
      return { ...sample };
    },
  });
  const resources = await createFleetResourceRuntime({ policy: async () => policy, governor });
  let child: ChildProcessWithoutNullStreams | undefined;
  let launches = 0;
  let disposed = 0;
  const admissions: string[] = [];
  const nativeSession = { source: "herdr:opencode", kind: "id" as const, value: "ses_resourceFixture123" };
  const ref = { harness: "opencode" as const, sessionId: nativeSession.value, paneId: "w1:p1" };
  const current = (): HerdrAgentSnapshot | undefined =>
    child && child.exitCode === null && child.signalCode === null
      ? {
          paneId: ref.paneId,
          terminalId: "term_resource",
          agent: "opencode",
          status: "idle",
          title: "Resource fixture",
          session: nativeSession,
        }
      : undefined;
  const proof = async (): Promise<SeatProcessIdentity> => {
    if (!child?.pid) throw new Error("No native fixture process");
    const identity = await processIdentity(child.pid);
    if (!identity) throw new Error("Native fixture exited");
    return {
      fleet: "default",
      pane: ref.paneId,
      nativeOccupantId: (await import("../src/captain/herdr-census.ts")).occupantIdForHerdrSession(
        nativeSession,
      ),
      binding: { socketPath: join(root, "private-fixture.sock") },
      processes: [{ pid: identity.pid, startTime: identity.startTime }],
      shell: { pid: identity.pid, startTime: identity.startTime },
    };
  };
  const exitChild = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, "close");
    child.stdin.end();
    await closed;
  };
  const control: SeatControl = {
    ref,
    send: async () => ({ outcome: "accepted", messageId: "msg_resourceFixture", state: "queued" }),
    status: async () => (current() ? "idle" : "offline"),
    settled: async () => new Promise(() => {}),
    interrupt: async () => false,
    close: async () => {},
    verify: proof,
    exit: async () => {
      await exitChild();
    },
  };
  const runner: HerdrWatchRunner = {
    createTab: async (options) => {
      if (!options.command) throw new Error("Only initial-command fixture launches are allowed");
      launches++;
      child = spawn(options.command[0]!, options.command.slice(1), { cwd: root, stdio: "pipe" });
      await once(child, "spawn");
      return ref.paneId;
    },
    startAgent: async () => {
      throw new Error("No native CLI fallback");
    },
    runInPane: async () => {
      throw new Error("No terminal input fallback");
    },
    get: async () => {
      const agent = current();
      if (!agent) throw new Error("Fixture process absent");
      return agent;
    },
    resolveTerminal: async () => current(),
    list: async () => (current() ? [current()!] : []),
    wait: async () => {
      const agent = current();
      if (!agent) throw new Error("Fixture process absent");
      return agent;
    },
    closePane: exitChild,
  };
  let launchBrief = "";
  const prepared: PreparedSeatLaunch = {
    command: [process.execPath, executable],
    verify: proof,
    dispose: async () => {
      disposed++;
    },
    start: async (view) => {
      await view.bound?.(ref);
      await view.guard?.();
      if (!child) throw new Error("Native fixture absent");
      const lines = createInterface({ input: child.stdout });
      const reply = once(lines, "line");
      child.stdin.write(`1 ${Buffer.from(launchBrief).toString("base64url")}\n`);
      const [line] = await reply;
      lines.close();
      if (JSON.parse(String(line)).result.mode !== Buffer.from(launchBrief).toString("base64url"))
        throw new Error("Native fixture did not acknowledge the exact first prompt");
      return { outcome: "started", control };
    },
  };
  const adapter: HarnessSeatAdapter = {
    harness: "opencode",
    prepare: async (launch) => {
      launchBrief = launch.brief;
      await prepareAction();
      return prepared;
    },
    start: async () => {
      throw new Error("No adapter fallback");
    },
    attach: async () => control,
  };
  resources.bindSeats({
    resolve: runner.resolveTerminal!,
    proof: async () => (current() ? proof() : undefined),
    isLocalFleet: async (fleet) => fleet === undefined || fleet === "default" || fleet === "named-local",
  });
  const store = new HerdrWatchStore(join(root, "watches.json"), {
    runner,
    seatAdapters: [adapter],
    fleetResources: resources,
    ...(projectHirePolicy === undefined ? {} : { projectHirePolicy }),
    nativeLaunchPolicy: {
      admit: async ({ phase }) => {
        admissions.push(phase);
      },
    },
  });
  const journal = async () => {
    const text = await readFile(join(root, "journal.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; mode?: string; pid: number });
  };
  cleanups.push(async () => {
    store.close();
    await resources.close();
    await exitChild();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    resources,
    store,
    admissions,
    journal,
    pressure: (value: ResourcePressureInput) => {
      sample = value;
    },
    failProbe: () => {
      probeFailure = true;
    },
    onPrepare: (action: () => Promise<void>) => {
      prepareAction = action;
    },
    onProbe: (action: () => Promise<void>) => {
      probeAction = action;
    },
    probes: () => probes,
    launches: () => launches,
    disposed: () => disposed,
    current,
    proof,
    hire: (brief?: string, authority?: ConversationAuthority) =>
      store.spawnSeat(
        {
          schemaVersion: 1,
          effort: "medium",
          effortReason: "Resource admission and native launch boundaries need integration checks.",
          harness: "opencode",
          title: "Resource fixture",
          workingDirectory: root,
        },
        undefined,
        brief,
        undefined,
        authority,
      ),
  };
}

// LOCAL-VUH-6: live 2026-10-12 refusal at conv-4c11af56 cursor 3628.
// Policy fields match the attempted Iris/LOCAL-VUH-4 hire. Paths are disposable;
// the existing executable helper proves native admission, not Codex/model behavior.
async function autoFixture(configuredOwner = false) {
  let settings: SettingsStore;
  let sourceDirectory: string;
  const resolve: ProjectHirePolicy["project"] = async (input, projects, authority) => {
    const destination = await localWorkspaceProject(projects, input.workingDirectory);
    if (!configuredOwner) return destination;
    const current = await settings.load();
    const source =
      configuredLeadHireProject(
        projects,
        current.linearWebhook.projectChats,
        authority?.owner.conversationId,
        input.projectId,
      ) ?? (await localWorkspaceProject(projects, sourceDirectory));
    return selectHireProject(source, destination, input.projectId);
  };
  const f = await fixture({
    settings: async () => (await settings.load()).projects,
    project: resolve,
    tools: async () => [],
  });
  settings = new SettingsStore(join(f.root, "settings.json"));
  sourceDirectory = join(f.root, "clankie");
  const workingDirectory = configuredOwner ? join(f.root, "tracker-research-20261008") : f.root;
  if (configuredOwner) {
    await mkdir(sourceDirectory);
    await mkdir(workingDirectory);
  }
  const personas = new PersonaStore(join(f.root, "personas"));
  await personas.ready(settings);
  cleanups.push(() => personas.close());
  await settings.update((current) => ({
    ...current,
    autonomy: { fleet: { ...current.autonomy.fleet, ...autonomyLevelFleet("full") } },
    ...(configuredOwner
      ? {
          linearWebhook: {
            ...current.linearWebhook,
            projectChats: [
              {
                projectId: "cbd205ab-cad4-48b8-9724-7109410fc921",
                name: "Clankie Work",
                conversationId: "conv-4c11af56-0e37-4870-9294-bf307fc3c0d0",
              },
            ],
          },
        }
      : {}),
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "clankie-work",
          name: "Clankie Work",
          auto: true,
          workerCap: 1,
          trackerProjectId: "cbd205ab-cad4-48b8-9724-7109410fc921",
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: workingDirectory }],
          roles: [{ role: "builder" }],
        },
        ...(configuredOwner
          ? [
              {
                id: "clankie",
                name: "Clankie",
                workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: sourceDirectory }],
              },
            ]
          : []),
      ],
    }),
  }));
  const app = createProjectRoutes(
    async (request) =>
      request.headers.get("authorization") === "Bearer fixture-owner" ? true : "authentication_required",
    settings,
  );
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await once(server, "listening");
  cleanups.push(async () => {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing project API");
  const host = `http://127.0.0.1:${address.port}`;
  const project = async (changes: Record<string, unknown>) => {
    const headers = { authorization: "Bearer fixture-owner", "content-type": "application/json" };
    const snapshot = await (
      await fetch(`${host}/v1/operator/projects?includeAutonomy=true`, { headers })
    ).json();
    const response = await fetch(`${host}/v1/operator/projects/update?includeAutonomy=true`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId: "clankie-work", expectedRevision: snapshot.revision, changes }),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  let enabled = true;
  let routeCurrent = true;
  const tool = captainTools(
    { embodiment: {} } as CaptainDeps,
    {
      targetId: "conv-4c11af56-0e37-4870-9294-bf307fc3c0d0",
      autonomous: true,
      conversationAuthority: {
        owner: { conversationId: "conv-4c11af56-0e37-4870-9294-bf307fc3c0d0" },
        current: () => routeCurrent,
        authorize: async () => routeCurrent,
      },
    },
    new LaneLog(f.root),
    "operator",
    undefined,
    undefined,
    undefined,
    async (request, brief, source, autonomous) => {
      if (!source || autonomous !== true) throw new Error("Missing host-stamped autonomous hire context");
      const authority = autoHireAuthority(source, async () => {
        const current = await settings.load();
        const id = await resolve(request, current.projects, source);
        return {
          autonomy: current.autonomy,
          project: current.projects.projects.find((p) => p.id === id),
          enabled,
        };
      });
      await assertConversationAuthority(authority);
      await personas.prepareRoleAdoption(request.role);
      let adopted: ReturnType<typeof personas.adoptSpawn> | undefined;
      const result = await f.store.spawnSeat(
        request,
        undefined,
        brief,
        undefined,
        authority,
        (spawned, projectId) => {
          adopted = personas.adoptSpawn(spawned.seat, request.title, request.role, undefined, projectId);
        },
        () => personas.flushProjectRoles(),
      );
      if (result.outcome !== "spawned") return result;
      if (!adopted) throw new Error("Missing adopted native seat");
      return { ...result, seat: adopted };
    },
  ).find((candidate) => candidate.name === "hire_agent")!;
  const hire = (directory = workingDirectory, projectId = "clankie-work") =>
    tool.execute(
      "LOCAL-VUH-4",
      {
        title: "Iris",
        projectId,
        role: "builder",
        workingDirectory: directory,
        harness: "opencode",
        deliverable: "LOCAL-VUH-4",
        effort: "medium",
        effortReason: "Resource admission and native launch boundaries need integration checks.",
        brief: "Read LOCAL-VUH-4 without changing accounts or credentials.",
      },
      undefined,
      undefined,
      {} as never,
    );
  return {
    ...f,
    settings,
    project,
    hire,
    sourceDirectory,
    pause: () => {
      enabled = false;
    },
    revoke: () => {
      routeCurrent = false;
    },
  };
}

it("refuses a new job without an effort rationale before any native process starts", async () => {
  const f = await fixture();
  const result = await f.store.spawnSeat(
    {
      schemaVersion: 1,
      title: "Missing job choice",
      harness: "opencode",
      workingDirectory: f.root,
      effort: "medium",
    },
    undefined,
    "Read the project and report evidence.",
  );
  expect(result).toMatchObject({
    outcome: "failed",
    reason: "not_ready",
    detail: expect.stringContaining("effortReason"),
  });
  expect(f.launches()).toBe(0);
});

it("LOCAL-VUH-6: preserves owner policy, project cap and resource refusals", async () => {
  const f = await autoFixture();
  await f.settings.update((current) => ({
    ...current,
    autonomy: { fleet: { ...current.autonomy.fleet, ...autonomyLevelFleet("high") } },
  }));
  await expect(f.hire()).rejects.toThrow("saved autonomy must be Full");
  await f.settings.update((current) => ({
    ...current,
    autonomy: { fleet: { ...current.autonomy.fleet, ...autonomyLevelFleet("full") } },
  }));
  await f.project({ auto: false });
  await expect(f.hire()).rejects.toThrow("project must be on Auto");
  await f.project({ auto: true, autonomy: { fleet: { machineSetup: "owner" } } });
  await expect(f.hire()).rejects.toThrow("working preferences require approval");
  await f.project({ workerCap: 0, autonomy: { fleet: { machineSetup: null } } });
  expect((await f.hire()).details).toMatchObject({
    outcome: "failed",
    detail: expect.stringContaining("allows 0 running agents"),
  });
  await f.project({ workerCap: 1 });
  f.pressure({ loadRatio: 0.1, availableMemoryMb: 1024 });
  expect((await f.hire()).details).toMatchObject({
    outcome: "failed",
    detail: expect.stringContaining("Local hire refused"),
  });
  expect(f.launches()).toBe(0);
});

it("LOCAL-VUH-6: starts one Full Auto hire through native admission, then enforces the cap", async () => {
  const f = await autoFixture();
  const accepted = (await f.hire()).details;
  expect(accepted, JSON.stringify(accepted)).toMatchObject({ outcome: "spawned" });
  expect(f.launches()).toBe(1);
  expect((await f.journal()).filter((row) => row.kind === "request")).toHaveLength(1);
  expect((await f.hire()).details).toMatchObject({
    outcome: "failed",
    detail: expect.stringContaining("allows 1 running agents"),
  });
  expect(f.launches()).toBe(1);
});

it("LOCAL-VUH-7: the configured Work lead hires into its primary folder despite its clankie conversation folder", async () => {
  const f = await autoFixture(true);
  const before = (await f.settings.load()).projects;
  const oldSource = await localWorkspaceProject(before, f.sourceDirectory);
  const destination = await localWorkspaceProject(before, join(f.root, "tracker-research-20261008"));
  expect(oldSource).toBe("clankie");
  expect(() => selectHireProject(oldSource, destination, "clankie-work")).toThrow(
    "This conversation and the new agent's folder belong to different projects.",
  );
  expect((await f.hire()).details).toMatchObject({ outcome: "spawned" });
  expect(f.launches()).toBe(1);
  const proof = await f.proof();
  const projects = (await f.settings.load()).projects;
  const lookup = (current: typeof proof | undefined) =>
    f.store.projectHireAssignment("default", "w1:p1", current);
  expect(
    await nativeHireProject(projects, proof.nativeOccupantId, proof, lookup, undefined, "clankie-work"),
  ).toBe("clankie-work");
  await expect(
    nativeHireProject(projects, "replaced-agent", proof, lookup, undefined, "clankie-work"),
  ).rejects.toThrow("original agent has changed");
  expect((await f.hire()).details).toMatchObject({
    outcome: "failed",
    detail: expect.stringContaining("allows 1 running agents"),
  });
  expect(f.launches()).toBe(1);
});

it("LOCAL-VUH-7: explicit ownership cannot hire another project or override destination membership", async () => {
  const f = await autoFixture(true);
  await expect(f.hire(f.sourceDirectory, "clankie")).rejects.toThrow(
    "not owned by this configured project lead",
  );
  await expect(f.hire(f.sourceDirectory)).rejects.toThrow("different projects");
  expect(f.launches()).toBe(0);
  expect(await f.journal()).toEqual([]);
});

it("LOCAL-VUH-7: rechecks saved lead ownership after preparation before launching", async () => {
  const f = await autoFixture(true);
  f.onPrepare(async () => {
    await f.settings.update((current) => ({
      ...current,
      linearWebhook: { ...current.linearWebhook, projectChats: [] },
    }));
  });
  expect((await f.hire()).details).toMatchObject({
    outcome: "failed",
    detail: expect.stringContaining("different projects"),
  });
  expect(f.launches()).toBe(0);
  expect(await f.journal()).toEqual([]);
});

it.each(["project-off", "autonomy-down", "master-off", "route-revoked"] as const)(
  "rechecks %s after preparation before an autonomous native effect",
  async (change) => {
    const f = await autoFixture();
    f.onPrepare(async () => {
      if (change === "project-off") await f.project({ auto: false });
      if (change === "autonomy-down")
        await f.settings.update((current) => ({
          ...current,
          autonomy: { fleet: { ...current.autonomy.fleet, ...autonomyLevelFleet("high") } },
        }));
      if (change === "master-off") f.pause();
      if (change === "route-revoked") f.revoke();
    });
    expect((await f.hire()).details).toMatchObject({ outcome: "failed" });
    expect(f.launches()).toBe(0);
    expect(await f.journal()).toEqual([]);
  },
);

it.each(["pressure", "probe-unavailable"] as const)(
  "refuses %s before a real native launch",
  async (reason) => {
    const f = await fixture();
    if (reason === "pressure") f.pressure({ loadRatio: 0.1, availableMemoryMb: 1024 });
    else f.failProbe();
    expect(await f.hire()).toMatchObject({
      outcome: "failed",
      reason: "not_ready",
      detail: expect.stringContaining("Local hire refused"),
    });
    expect(f.admissions).toEqual(["request"]);
    expect(f.launches()).toBe(0);
    expect(await f.journal()).toEqual([]);
  },
);

it.each(["pressure", "probe-unavailable"] as const)(
  "rechecks %s after prepare, before the initial native command",
  async (reason) => {
    const f = await fixture();
    f.onPrepare(async () => {
      if (reason === "pressure") f.pressure({ loadRatio: 0.1, availableMemoryMb: 1024 });
      else f.failProbe();
    });
    expect(await f.hire("Work on the fixture")).toMatchObject({
      outcome: "failed",
      reason: "not_ready",
      detail: expect.stringContaining("Local hire refused"),
    });
    expect(f.admissions).toEqual(["request", "launch"]);
    expect(f.launches()).toBe(0);
    expect(f.disposed()).toBe(1);
    expect(await f.journal()).toEqual([]);
  },
);

it("admits a hire at high load above the memory floor and says its heavy work will queue", async () => {
  const f = await fixture();
  f.pressure({ loadRatio: 3, availableMemoryMb: 8192 });
  const result = await f.hire("Work on the fixture");
  expect(result).toMatchObject({
    outcome: "spawned",
    resourceNotice: expect.stringContaining("will queue until load drops"),
  });
  expect(f.admissions).toEqual(["request", "launch"]);
  expect(f.launches()).toBe(1);
  expect(f.current()).toBeDefined();
});

it("a hire at normal load carries no queue notice", async () => {
  const f = await fixture();
  const result = await f.hire("Work on the fixture");
  expect(result.outcome).toBe("spawned");
  expect(result).not.toHaveProperty("resourceNotice");
});

it("delivers resource instructions once without a user brief and retains the accepted native lifetime", async () => {
  const f = await fixture();
  expect(await f.hire()).toMatchObject({ outcome: "spawned" });
  expect(f.admissions).toEqual(["request", "launch"]);
  expect(f.launches()).toBe(1);
  const messages = (await f.journal()).filter((row) => row.kind === "request");
  expect(messages).toHaveLength(1);
  const brief = Buffer.from(messages[0]!.mode!, "base64url").toString("utf8");
  expect(brief).toContain("clankie heavy -- <command>");
  expect(brief).toContain("fleet-resources skill");
  expect(brief).toContain("clankie simulator");
  expect(brief.match(/Machine resource safety:/gu)).toHaveLength(1);
  f.pressure({ loadRatio: 0.1, availableMemoryMb: 1024 });
  await expect(f.resources.admitHire({})).rejects.toThrow("Local hire refused");
  expect(f.current()).toBeDefined();
  f.store.close();
  await f.resources.close();
  expect(f.current()).toBeDefined();
});

it("a grant revoked during the final real pressure observation cannot launch a native process", async () => {
  const f = await fixture();
  let admitted = true;
  f.onPrepare(async () => {
    f.onProbe(async () => {
      admitted = false;
    });
  });
  const result = await f.hire("Owned fixture task", {
    owner: { conversationId: "global-default" },
    current: () => admitted,
    authorize: async () => admitted,
  });
  expect(result).toMatchObject({
    outcome: "failed",
    detail: expect.stringContaining("authority is unavailable"),
  });
  expect(f.launches()).toBe(0);
  expect(f.disposed()).toBe(1);
  expect(await f.journal()).toEqual([]);
});

it("uses actual local-host classification and keeps cached metadata reads off pressure probes", async () => {
  const f = await fixture();
  f.pressure({ loadRatio: 0.1, availableMemoryMb: 1024 });
  const before = f.probes();
  await expect(f.resources.admitHire({ fleet: "named-local" })).rejects.toThrow("Local hire refused");
  const afterLocal = f.probes();
  expect(afterLocal).toBeGreaterThan(before);
  await f.resources.admitHire({ fleet: "confirmed-remote" });
  for (let i = 0; i < 100; i++) expect(f.resources.status()).toBeDefined();
  expect(f.probes()).toBe(afterLocal);
});

it("refreshes readings without waking an idle fleet and publishes pressure boundary changes", async () => {
  const f = await fixture();
  let changes = 0;
  const unsubscribe = f.resources.onChange(() => {
    changes++;
  });
  f.pressure({ loadRatio: 0.2, availableMemoryMb: 7000 });
  await f.resources.refresh();
  expect(f.resources.status()?.pressure.loadRatio).toBe(0.2);
  expect(changes).toBe(0);
  f.pressure({ loadRatio: 3, availableMemoryMb: 7000 });
  await f.resources.refresh();
  expect(changes).toBe(1);
  unsubscribe();
});

it("an installed façade missing its real native helper remains constructible and refuses local admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-resource-missing-helper-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const execute = promisify(execFile);
  const bundle = join(root, "runtime.mjs");
  const entry = join(root, "entry.ts");
  // The façade plus the governor it builds, so the probe can point that
  // governor at a fresh registry instead of this machine's live one.
  await writeFile(
    entry,
    `export { createFleetResourceRuntime } from ${JSON.stringify(fileURLToPath(new URL("../src/fleet-resource-runtime.ts", import.meta.url)))};
export { createResourceGovernor } from ${JSON.stringify(fileURLToPath(new URL("../../../packages/fleet-resources/src/governor.ts", import.meta.url)))};
`,
  );
  // Bundle the actual production façade into an isolated install-shaped
  // location. Deliberately omit native.py; no shared source/env is modified.
  await execute(
    fileURLToPath(new URL("../../../node_modules/.bin/esbuild", import.meta.url)),
    [
      entry,
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--target=node24",
      '--banner:js=import { createRequire as __clankieCreateRequire } from "node:module"; const require = __clankieCreateRequire(import.meta.url);',
      `--outfile=${bundle}`,
    ],
    { timeout: 10_000 },
  );
  const probe = join(root, "probe.mjs");
  await writeFile(
    probe,
    `
import { createFleetResourceRuntime, createResourceGovernor } from ${JSON.stringify(bundle)};
let errors = 0;
const governor = createResourceGovernor({directory: ${JSON.stringify(join(root, "registry"))}});
const runtime = await createFleetResourceRuntime({governor, policy: async () => undefined, onError: () => { errors++; }});
runtime.bindSeats({resolve: async () => undefined, proof: async () => undefined, isLocalFleet: async () => true});
let admission;
try { await runtime.admitHire({}); admission = {allowed: true}; }
catch (error) { admission = {allowed: false, reason: error.reason, message: error.message}; }
console.log(JSON.stringify({constructed: true, status: runtime.status() ?? null, errors, admission}));
await runtime.close();
`,
  );
  const result = JSON.parse(
    (await execute(process.execPath, [probe], { cwd: root, timeout: 10_000 })).stdout,
  );
  // An empty registry reads without the helper, so status is honest rather
  // than absent: the pressure probe is reported unavailable.
  expect(result).toMatchObject({
    constructed: true,
    status: { leases: [], pressure: { healthy: false, reason: "probe-unavailable" } },
    errors: 0,
    admission: {
      allowed: false,
      reason: "probe-unavailable",
      message: expect.stringContaining("Local hire refused"),
    },
  });
});
