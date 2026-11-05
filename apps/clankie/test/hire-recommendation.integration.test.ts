// Real fleet-capacity reader and protocol projections -> advisory recommender.
// Account/host fixtures supply observations; real HTTP and the CLI reach the service.
import { hostname } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";
import { ClankieSettingsSchema, emptySettings } from "@clankie/settings";
import {
  OperatorConversationServiceRequestSchema,
  OperatorConversationServiceResultSchema,
  type OperatorConversationServiceRequest,
  FleetCapacitySchema,
  FleetMachineResourceSnapshotSchema,
  HireRecommendationSchema,
  type FleetMachineResourceSnapshot,
} from "@clankie/protocol";
import {
  createFleetCapacityReader,
  type FleetCapacityAccountSource,
  type FleetCapacitySeatSource,
} from "../src/app/fleet-capacity.ts";
import { hireAdmissionReport } from "../src/captain/hire-admission.ts";
import { allocateAccounts } from "../src/captain/account-allocation.ts";
import type { WorkerAccountStatus } from "../src/captain/harness-accounts.ts";
import { recommendHire } from "../src/captain/hire-recommendation.ts";

const exec = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

type Account = FleetCapacityAccountSource;
async function fixture() {
  const now = () => new Date().toISOString();
  const settings = ClankieSettingsSchema.parse({
    ...emptySettings(),
    machines: [{ id: "pc", ssh: "test@pc", shell: "posix" }],
    execution: {
      ...emptySettings().execution,
      connections: [
        { id: "pc", machine: "pc", session: "default", ssh: { host: "test@pc", shell: "posix" } },
      ],
    },
    projects: {
      projects: [
        {
          id: "proof",
          name: "proof",
          workspaces: [
            { id: "local", machineId: "local", platform: "posix", path: "/fixture/local" },
            { id: "pc", machineId: "pc", platform: "posix", path: "/fixture/pc" },
          ],
        },
      ],
    },
  });
  const account = (harness: "codex" | "claude", label: string, headroom: number): Account => ({
    harness,
    label,
    signedIn: true,
    usable: true,
    headroom,
    plan: "pro",
    usage: {
      source: harness === "claude" ? "claude-usage" : "codex-rate-limits",
      observedAt: now(),
      windows: [{ id: "week", label: "Week", usedPercent: (1 - headroom) * 100 }],
    },
  });
  const accounts: Record<string, Account[]> = {
    local: [account("claude", "primary", 0.5), account("codex", "backup", 0.8)],
    pc: [account("codex", "remote", 0.9)],
  };
  const spare: Record<string, number | null> = { primary: 0.3, backup: 0.5, remote: 0.7 };
  const resources: Record<string, FleetMachineResourceSnapshot> = {};
  const reading = (machine: string): FleetMachineResourceSnapshot => ({
    schemaVersion: 1,
    machine,
    policy: {
      heavySlots: null,
      simulatorSlots: null,
      simulatorIdleMs: 600_000,
      maxLoadRatio: 1.5,
      minAvailableMemoryMb: 4096,
      minFreeDiskGb: 20,
      warnFreeDiskGb: 200,
      warnFreeDiskPercent: 10,
    },
    specs: { platform: "linux", cores: 8, memoryBytes: 48 * 1024 ** 3 },
    status: "available",
    observedAt: now(),
    snapshot: {
      schemaVersion: 1,
      policy: {
        heavySlots: null,
        simulatorSlots: null,
        simulatorIdleMs: 600_000,
        maxLoadRatio: 1.5,
        minAvailableMemoryMb: 4096,
        minFreeDiskGb: 20,
        warnFreeDiskGb: 200,
        warnFreeDiskPercent: 10,
      },
      capacity: { heavySlots: 2, used: 0, simulatorSlots: 1, lightSlots: 2, lightUsed: 0 },
      leases: [],
      queue: [],
      lightQueue: [],
      pressure: {
        sampledAtMs: Date.now(),
        loadRatio: 0.4,
        availableMemoryMb: 8000,
        freeDiskGb: 500,
        diskWarning: false,
        healthy: true,
      },
    },
  });
  resources.local = FleetMachineResourceSnapshotSchema.parse(reading("local"));
  resources.pc = FleetMachineResourceSnapshotSchema.parse(reading("pc"));
  let granted = true;
  const seats: FleetCapacitySeatSource[] = [];
  const read = () =>
    createFleetCapacityReader({
      settings: async () => settings,
      accounts: async (fleet) => ({
        machine: fleet ?? "local",
        accounts: accounts[fleet ?? "local"]!,
        allocation: {
          accounts: accounts[fleet ?? "local"]!.map((a) => ({
            harness: a.harness,
            label: a.label,
            sparePerDay: spare[a.label] ?? null,
          })),
        },
      }),
      seats: async () => seats,
      leadSeatId: () => undefined,
      heavy: () => undefined,
      tracker: () => undefined,
      sessionBurn: async () => ({ sessions: [], truncated: false }),
      machineResources: { ids: async () => ["local", "pc"], status: async (machine) => resources[machine]! },
    });
  const places = [
    {
      place: { machine: hostname(), project: "proof", workingDirectory: "/fixture/local" },
      names: new Set(["local", hostname().toLowerCase()]),
      machineKey: "local",
    },
    {
      place: { machine: "test@pc", project: "proof", workingDirectory: "/fixture/pc" },
      names: new Set(["pc", "test@pc"]),
      machineKey: "remote:pc",
      fleet: "pc",
    },
  ];
  let launches = 0;
  const requests: OperatorConversationServiceRequest[] = [];
  const serve = createOperatorService({
    shutdown: new AbortController(),
    personas: { ready: async () => {} },
    settings: async () => settings,
    deps: { fleets: { remoteWorkspace: async () => granted } },
    fleetCapacity: (...args: Parameters<ReturnType<typeof createFleetCapacityReader>>) => read()(...args),
    hireSeat: async () => {
      launches++;
      throw Error("A recommendation must never launch");
    },
  } as unknown as CreateOperatorServiceContext);
  const http = createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const request = OperatorConversationServiceRequestSchema.parse(JSON.parse(body));
      requests.push(request);
      const result = OperatorConversationServiceResultSchema.parse(await serve(request));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(500);
      res.end(String(error));
    }
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const host = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const dispatch = async (extra: Record<string, unknown> = {}) => {
    const response = await fetch(host, {
      method: "POST",
      body: JSON.stringify({ op: "start_agent", schemaVersion: 1, recommend: true, ...extra }),
    });
    expect(response.status).toBe(200);
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
  cleanups.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  return {
    host,
    dispatch,
    requests,
    launches: () => launches,
    accounts,
    seats,
    spare,
    resources,
    reading,
    read,
    grant: (value: boolean) => {
      granted = value;
    },
    advise: async (choices: Parameters<typeof recommendHire>[1] = {}) =>
      HireRecommendationSchema.parse(
        recommendHire(
          places.filter((entry) => !entry.fleet || granted),
          choices,
          await read()(true, true),
        ),
      ),
  };
}

it("recommends known spare capacity and explains its choice in one line", async () => {
  const f = await fixture();
  const advice = await f.advise();
  expect(advice).toMatchObject({
    status: "recommended",
    machine: "test@pc",
    workingDirectory: "/fixture/pc",
    harness: "codex",
    account: "remote",
    unknown: [],
    reason: expect.stringContaining("90% plan remaining"),
  });
  expect(advice.reason).toContain("host-reported");
  expect(advice.reason).not.toMatch(/[\r\n\u2028\u2029]/u);
});

it("keeps explicit choices and never substitutes another place, harness or account", async () => {
  const f = await fixture();
  expect(
    await f.advise({
      machine: "local",
      workingDirectory: "/fixture/local",
      harness: "claude",
      account: "primary",
    }),
  ).toMatchObject({ status: "recommended", machine: hostname(), harness: "claude", account: "primary" });
  for (const choices of [
    { machine: "missing" },
    { workingDirectory: "/not-granted" },
    { account: "missing" },
    { machine: "pc", harness: "claude" as const },
    { machine: "local", account: "remote" },
  ])
    expect(await f.advise(choices)).toMatchObject({ status: "unavailable" });
  f.grant(false);
  expect(await f.advise({ machine: "pc" })).toMatchObject({ status: "unavailable" });
});

it("never credits unknown, exhausted, held, unusable, signed-out or stale account capacity", async () => {
  const f = await fixture();
  const original = f.accounts.pc![0]!;
  for (const change of [
    { headroom: null },
    { headroom: 0 },
    { held: { reason: "owner held" } },
    { usable: false },
    { signedIn: null },
    { signedIn: false },
    { usage: undefined },
    { usage: { ...original.usage!, observedAt: new Date(Date.now() - 120_000).toISOString() } },
    { usage: { ...original.usage!, observedAt: new Date(Date.now() + 120_000).toISOString() } },
  ]) {
    f.accounts.pc = [{ ...original, ...change }];
    expect(await f.advise({ machine: "pc" })).toMatchObject({ status: "unavailable" });
  }
  f.accounts.pc = [original];
  for (const spare of [null, 0, -0.1]) {
    f.spare.remote = spare;
    expect(await f.advise({ machine: "pc" })).toMatchObject({ status: "unavailable" });
  }
});

it("excludes stale, untimed, mismatched, busy, queued and low-disk hosts", async () => {
  const f = await fixture();
  const original = f.reading("pc");
  if (original.status !== "available") throw Error("fixture");
  for (const change of [
    { ...original, status: "unavailable", reason: "probe-unavailable" },
    { ...original, observedAt: new Date(Date.now() - 120_000).toISOString() },
    { ...original, observedAt: new Date(Date.now() + 120_000).toISOString() },
    { ...original, observedAt: undefined, snapshot: { ...original.snapshot, pressure: undefined } },
    { ...original, machine: "local" },
    {
      ...original,
      snapshot: { ...original.snapshot, capacity: { ...original.snapshot.capacity, used: 2, lightUsed: 2 } },
    },
    {
      ...original,
      snapshot: {
        ...original.snapshot,
        queue: [{ id: "q", kind: "heavy", queuedAtMs: Date.now() }],
        lightQueue: [{ id: "q2", queuedAtMs: Date.now() }],
      },
    },
    {
      ...original,
      snapshot: { ...original.snapshot, pressure: { ...original.snapshot.pressure!, diskWarning: true } },
    },
  ]) {
    f.resources.pc = change as FleetMachineResourceSnapshot;
    expect(await f.advise({ machine: "pc" })).toMatchObject({ status: "unavailable" });
  }
});

it("keeps missing readings unknown and pressure absent for existing capacity clients", async () => {
  const f = await fixture();
  expect(FleetCapacitySchema.parse(await f.read()(true)).machineResources?.pc).not.toHaveProperty("pressure");
  expect(FleetCapacitySchema.parse(await f.read()(true, true)).machineResources?.pc).toHaveProperty(
    "pressure.freeDiskGb",
    500,
  );
  const reading = f.reading("pc");
  if (reading.status !== "available") throw Error("fixture");
  f.resources.pc = { ...reading, snapshot: { ...reading.snapshot, pressure: undefined } };
  expect(await f.advise({ machine: "pc" })).toMatchObject({
    status: "recommended",
    unknown: ["load", "disk"],
    reason: expect.stringContaining("disk unknown"),
  });
  expect(recommendHire([], {}, undefined)).toMatchObject({ status: "unavailable" });
});

it("uses context aliases, load and disk to break ties and leaves unidentified panes unknown", async () => {
  const f = await fixture();
  f.spare.backup = 0.7;
  f.accounts.local = [{ ...f.accounts.local![1]!, headroom: 0.9 }];
  f.seats.push(
    {
      seatId: "local-one",
      harness: "codex",
      machine: hostname(),
      account: { label: "backup" },
      title: "local",
      efficiency: { contextPercent: 80 },
    },
    {
      seatId: "pc-one",
      harness: "codex",
      machine: "test@pc",
      account: { label: "remote" },
      title: "pc",
      efficiency: { contextPercent: 20 },
    },
  );
  expect(await f.advise()).toMatchObject({
    machine: "test@pc",
    reason: expect.stringContaining("20% peak context"),
  });
  f.seats.splice(0, 2, { seatId: "unknown", harness: "codex", title: "unidentified" });
  expect(await f.advise({ machine: "pc" })).toMatchObject({
    unknown: ["context"],
    reason: expect.stringContaining("context unknown"),
  });
  f.seats.splice(0);
  const local = f.reading("local");
  if (local.status !== "available") throw Error("fixture");
  f.resources.local = {
    ...local,
    snapshot: { ...local.snapshot, pressure: { ...local.snapshot.pressure!, loadRatio: 0.1 } },
  };
  expect(await f.advise()).toMatchObject({ account: "backup" });
  f.resources.local = {
    ...local,
    snapshot: { ...local.snapshot, pressure: { ...local.snapshot.pressure!, freeDiskGb: 1000 } },
  };
  expect(await f.advise()).toMatchObject({ account: "backup" });
});

it("never recommends account usage the real hire gate reserves or budgets for running work", async () => {
  const f = await fixture();
  const now = Date.now();
  for (const [remaining, stopAtPercent, permitted] of [
    [0.11, undefined, true],
    [0.1, undefined, false],
    [0.05, undefined, false],
    [0.5, 50, false],
    [0.51, 50, true],
    [0.05, 99, true],
    [0.01, 99, false],
  ] as const) {
    const account: WorkerAccountStatus = {
      harness: "codex",
      label: "remote",
      home: "/fixture/account",
      signedIn: true,
      usable: true,
      headroom: remaining,
      plan: "pro",
      ...(stopAtPercent === undefined ? {} : { budget: { stopAtPercent } }),
      usage: {
        source: "codex-rate-limits",
        observedAt: new Date(now).toISOString(),
        windows: [
          {
            id: "week",
            label: "Week",
            usedPercent: (1 - remaining) * 100,
            resetsAt: new Date(now + 60_000).toISOString(),
            windowMinutes: 10_080,
          },
        ],
      },
    };
    const report = {
      machine: "pc",
      shell: "posix" as const,
      observedAt: new Date(now).toISOString(),
      accounts: [account],
    };
    const allocation = allocateAccounts(report, now);
    expect(allocation.accounts[0]?.sparePerDay).toBeGreaterThan(0);
    expect(hireAdmissionReport(report, undefined, [], now).accounts[0]?.usable).toBe(permitted);
    f.accounts.pc = [account];
    f.spare.remote = allocation.accounts[0]!.sparePerDay;
    expect((await f.advise({ machine: "pc" })).status).toBe(permitted ? "recommended" : "unavailable");
  }
});

it("exposes read-only advice through API and the shipped CLI without creating a start receipt", async () => {
  const f = await fixture();
  expect(await f.dispatch()).toMatchObject({
    status: "places",
    recommendation: {
      status: "recommended",
      machine: "test@pc",
      harness: "codex",
      account: "remote",
    },
  });
  const result = await exec(
    process.execPath,
    [
      "--import",
      resolve("apps/tui/node_modules/tsx/dist/loader.mjs"),
      resolve("apps/tui/bin/clankie.ts"),
      "agents",
      "recommend",
      "--machine",
      "local",
      "--harness",
      "claude",
      "--account",
      "primary",
    ],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        CLANKIE_CAPTAIN_TOKEN: "fixture-token",
        CLANKIE_CONTROL_PLANE_URL: f.host,
      },
      timeout: 30_000,
    },
  );
  expect(JSON.parse(result.stdout)).toMatchObject({
    status: "recommended",
    machine: hostname(),
    harness: "claude",
    account: "primary",
  });
  expect(f.requests.at(-1)).toMatchObject({
    op: "start_agent",
    recommend: true,
    machine: "local",
    harness: "claude",
    account: "primary",
  });
  const constrained = await f.dispatch({
    machine: "local",
    workingDirectory: "/fixture/local",
    harness: "claude",
    account: "primary",
  });
  expect(constrained).toMatchObject({
    status: "places",
    recommendation: { status: "recommended", harness: "claude", account: "primary" },
  });
  expect(constrained).not.toHaveProperty("startId");
  expect(await f.dispatch({ recommend: false })).not.toHaveProperty("recommendation");
  expect(await f.dispatch({ startId: "e3c9e88c-f9bf-4d33-b140-98d0aa90b4a1" })).toMatchObject({
    status: "refused",
  });
  expect(f.launches()).toBe(0);
});

it("keeps API constraints and directory grants while declining unknown or budgeted choices", async () => {
  const f = await fixture();
  for (const choice of [
    { machine: "missing" },
    { workingDirectory: "/not-granted" },
    { machine: "pc", harness: "claude" },
    { machine: "local", account: "remote" },
  ])
    expect(await f.dispatch(choice)).toMatchObject({ recommendation: { status: "unavailable" } });
  f.grant(false);
  expect(await f.dispatch({ machine: "pc" })).toMatchObject({ recommendation: { status: "unavailable" } });
  f.grant(true);
  f.spare.remote = null;
  expect(await f.dispatch({ machine: "pc" })).toMatchObject({ recommendation: { status: "unavailable" } });
  f.spare.remote = 0.7;
  f.accounts.pc = [{ ...f.accounts.pc![0]!, budget: { stopAtPercent: 10 } }];
  expect(await f.dispatch({ machine: "pc" })).toMatchObject({ recommendation: { status: "unavailable" } });
  expect(f.launches()).toBe(0);
});
