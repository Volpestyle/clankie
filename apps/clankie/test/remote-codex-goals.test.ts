import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { readCodexGoal } from "@clankie/agent-transcript";
import type { OperatorFleetSeat } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { createRemoteCodexGoals } from "../src/captain/remote-codex-goals.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { ObservedFleetSeat } from "../src/captain/herdr-census.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import type { FleetShellRun, HerdrFleet } from "../src/herdr-fleet.ts";

const run = promisify(execFile);
const roots: string[] = [];
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "clankie-remote-goals-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const id = "01999000-0000-7000-8000-000000000001";
const otherId = "01999000-0000-7000-8000-000000000002";
const fleet: HerdrFleet = { id: "pc", session: "owner", ssh: { host: "pc", shell: "posix" } };
const session = { source: "herdr:codex", kind: "id" as const, value: id };
const seat = {
  seatId: "pc/seat",
  occupantId: "native",
  personaId: "juniper",
  harness: "codex",
  fleet: "pc",
  status: "idle",
  title: "Juniper",
} satisfies OperatorFleetSeat;
const observed: ObservedFleetSeat = {
  ...seat,
  subject: "juniper",
  paneId: "pc/w1:p1",
  machine: fleet.ssh.host,
  herdrSession: fleet.session,
  session,
};
const row = {
  objective: "Verify the remote app — café",
  status: "active",
  token_budget: 40000,
  tokens_used: 5000,
  time_used_seconds: 12,
  created_at_ms: 1700000000000,
  updated_at_ms: 1700000001000,
};
function store(home: string) {
  const db = new DatabaseSync(join(home, "goals_1.sqlite"));
  db.exec(
    "CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, objective TEXT, status TEXT, token_budget INTEGER, tokens_used INTEGER, time_used_seconds INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER)",
  );
  const insert = db.prepare("INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run(id, ...Object.values(row));
  insert.run(otherId, "Private unrelated goal", ...Object.values(row).slice(1));
  return db;
}
function localShell(home: string) {
  // Execute the actual command sent over SSH, using a real SQLite store, with
  // the remote account environment represented by this temporary directory.
  return vi.fn<FleetShellRun>(async (command, timeout) => {
    const result = await run("/bin/sh", ["-c", command], {
      env: { ...process.env, CODEX_HOME: home },
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
    return result.stdout;
  });
}

it("reads only observed sessions with the local goal fields and states, without changing the store", async () => {
  const home = scratch();
  const db = store(home);
  const shell = localShell(home);
  let now = 0;
  const project = createRemoteCodexGoals({ shell: () => shell, now: () => now });
  try {
    for (const status of ["active", "paused", "blocked", "budgetLimited", "usageLimited", "complete"]) {
      db.prepare("UPDATE thread_goals SET status = ? WHERE thread_id = ?").run(status, id);
      const before = readFileSync(join(home, "goals_1.sqlite"));
      const result = await project([seat], [observed], [fleet]);
      expect(result[0]?.goal).toEqual(readCodexGoal(session, [home]));
      expect(result[0]?.status).toBe("idle");
      expect(readFileSync(join(home, "goals_1.sqlite"))).toEqual(before);
      const response = await shell.mock.results.at(-1)!.value;
      expect(JSON.parse(response)).toEqual([[id, { ...row, status }]]);
      expect(response).not.toContain("Private unrelated goal");
      expect(shell.mock.calls.at(-1)?.[1]).toBe(5000);
      now += 10_000;
    }
  } finally {
    db.close();
  }
});

it("shares concurrent reads and caches both success and unknown while preserving native timestamps", async () => {
  let now = 0;
  let complete!: (value: string) => void;
  const shell = vi.fn<FleetShellRun>(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const project = createRemoteCodexGoals({ shell: () => shell, now: () => now });
  const first = project([seat], [observed], [fleet]);
  const concurrent = project([seat], [observed], [fleet]);
  expect(shell).toHaveBeenCalledTimes(1);
  complete(JSON.stringify([[id, row]]));
  const original = (await first)[0]?.goal;
  expect(original).toBeDefined();
  expect((await concurrent)[0]?.goal).toEqual(original);
  await project([seat], [observed], [fleet]);
  expect(shell).toHaveBeenCalledTimes(1);
  for (const response of [
    "[]",
    "broken json",
    JSON.stringify([[id, { ...row, status: "imaginary" }]]),
    JSON.stringify([[id, { ...row, updated_at_ms: null }]]),
  ]) {
    now += 10_000;
    shell.mockResolvedValue(response);
    expect((await project([seat], [observed], [fleet]))[0]?.goal).toEqual(original);
    const calls = shell.mock.calls.length;
    await project([seat], [observed], [fleet]);
    expect(shell).toHaveBeenCalledTimes(calls);
  }
  now += 10_000;
  shell.mockRejectedValue(new Error("unreachable"));
  expect((await project([seat], [observed], [fleet]))[0]?.goal).toEqual(original);
  // A failed census itself yields no seat, without throwing away the cache.
  expect(await project([], [], [fleet])).toEqual([]);
  now += 10_000;
  expect((await project([seat], [observed], [fleet]))[0]?.goal).toEqual(original);
  shell.mockResolvedValue(JSON.stringify([[id, { ...row, status: "paused", updated_at_ms: 1700000002000 }]]));
  now += 10_000;
  expect((await project([seat], [observed], [fleet]))[0]?.goal).toMatchObject({
    status: "paused",
    updatedAt: "2023-11-14T22:13:22.000Z",
  });
});

it("missing or incompatible stores remain unknown without creating files and preserve a prior goal", async () => {
  const home = scratch();
  const shell = localShell(home);
  let now = 0;
  const project = createRemoteCodexGoals({ shell: () => shell, now: () => now });
  expect((await project([seat], [observed], [fleet]))[0]?.goal).toBeUndefined();
  expect(existsSync(join(home, "goals_1.sqlite"))).toBe(false);
  const db = store(home);
  db.close();
  now += 10_000;
  const original = (await project([seat], [observed], [fleet]))[0]?.goal;
  expect(original).toBeDefined();
  const changed = new DatabaseSync(join(home, "goals_1.sqlite"));
  changed.exec("DROP TABLE thread_goals");
  changed.close();
  now += 10_000;
  expect((await project([seat], [observed], [fleet]))[0]?.goal).toEqual(original);
  rmSync(join(home, "goals_1.sqlite"));
  now += 10_000;
  expect((await project([seat], [observed], [fleet]))[0]?.goal).toEqual(original);
  expect(existsSync(join(home, "goals_1.sqlite"))).toBe(false);
});

it("rejects unobserved, unsupported or invalid sessions and never transfers cached goals to replacement identities", async () => {
  const shell = vi.fn<FleetShellRun>().mockResolvedValue(JSON.stringify([[id, row]]));
  const project = createRemoteCodexGoals({ shell: () => shell });
  for (const observation of [
    undefined,
    { ...observed, occupantId: "replacement" },
    { ...observed, fleet: "other" },
    { ...observed, harness: "claude" },
    { ...observed, session: { ...session, value: "'; $(touch /tmp/unwanted)" } },
  ]) {
    expect((await project([seat], observation ? [observation] : [], [fleet]))[0]?.goal).toBeUndefined();
  }
  expect(shell).not.toHaveBeenCalled();
  expect((await project([seat], [observed], [fleet]))[0]?.goal).toBeDefined();
  // The transport returned another UUID's row; this request cannot consume it.
  const replacement = { ...observed, occupantId: "new", session: { ...session, value: otherId } };
  expect((await project([{ ...seat, occupantId: "new" }], [replacement], [fleet]))[0]?.goal).toBeUndefined();
  shell.mockResolvedValue("[]");
  expect(
    (await project([seat], [observed], [{ ...fleet, ssh: { ...fleet.ssh, host: "replacement" } }]))[0]?.goal,
  ).toBeUndefined();
  expect((await project([seat], [observed], [fleet]))[0]?.goal).toBeUndefined();
});

it("does not read an old host or Herdr session's observed UUID on a replacement connection", async () => {
  for (const replacement of [
    { ...fleet, ssh: { ...fleet.ssh, host: "new-host" } },
    { ...fleet, session: "new-session" },
  ]) {
    const shell = vi.fn<FleetShellRun>().mockResolvedValue(JSON.stringify([[id, row]]));
    const project = createRemoteCodexGoals({ shell: () => shell });
    expect((await project([seat], [observed], [fleet]))[0]?.goal).toBeDefined();
    expect(shell).toHaveBeenCalledTimes(1);
    // Same seat, fleet ID and native UUID, but census predates reconfiguration.
    expect((await project([seat], [observed], [replacement]))[0]?.goal).toBeUndefined();
    expect(shell).toHaveBeenCalledTimes(1);
    // Only a census of that new connection authorizes a fresh read there.
    const current = { ...observed, machine: replacement.ssh.host, herdrSession: replacement.session };
    expect((await project([seat], [current], [replacement]))[0]?.goal).toBeDefined();
    expect(shell).toHaveBeenCalledTimes(2);
  }
});

it("bounds each fleet batch and retries unread sessions on the next poll", async () => {
  const shell = vi.fn<FleetShellRun>().mockResolvedValue("[]");
  const project = createRemoteCodexGoals({ shell: () => shell, now: () => 0 });
  const seats = Array.from({ length: 49 }, (_, index) => ({
    ...seat,
    seatId: `pc/seat${index}`,
    occupantId: `${index}`,
  }));
  const observations = seats.map((entry, index) => ({
    ...observed,
    ...entry,
    session: { ...session, value: `${id.slice(0, -4)}${index.toString().padStart(4, "0")}` },
  }));
  await project(seats, observations, [fleet]);
  await project(seats, observations, [fleet]);
  expect(shell).toHaveBeenCalledTimes(2);
  // Execute the command against a real store: its own payload guard rejects
  // batches over 48, and only the next session is queried on the second call.
  const home = scratch();
  const db = store(home);
  db.close();
  const execute = localShell(home);
  expect(JSON.parse(await execute(...shell.mock.calls[0]!))).toHaveLength(48);
  expect(JSON.parse(await execute(...shell.mock.calls[1]!))).toHaveLength(1);
});

it("projects the remote Herdr-observed session through fleet and roster without resuming a thread", async () => {
  const root = scratch();
  const db = store(root);
  db.close();
  const shell = localShell(root);
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  vi.spyOn(HerdrWatchStore.prototype, "trackSeat").mockImplementation(() => {});
  const agents = [
    {
      pane_id: "w1:p1",
      terminal_id: "seat",
      agent: "codex",
      agent_status: "idle",
      agent_session: session,
    },
  ];
  const herdr = vi.fn(async (args: readonly string[]) => {
    if (args.join(" ") === "agent list")
      return JSON.stringify({ result: { agents: structuredClone(agents) } });
    if (args.join(" ") === "api snapshot")
      return JSON.stringify({ result: { snapshot: { agents: structuredClone(agents) } } });
    throw new Error(`Unexpected remote census command: ${args.join(" ")}`);
  });
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      fleets: {
        list: [fleet],
        run: () => herdr,
        shell: () => shell,
        remoteWorkspace: async () => false,
      },
    } as unknown as CaptainDeps,
    { repoRoot: root, stateDir: root, settings: new SettingsStore(join(root, "settings.json")) },
  );
  try {
    const response = await captain.serveOperatorConversation({
      op: "fleet",
      schemaVersion: 1,
      includeWork: true,
    });
    if (response.op !== "fleet") throw new Error("Expected fleet");
    expect(response.snapshot.seats[0]).toMatchObject({
      seatId: "pc/seat",
      fleet: "pc",
      status: "idle",
      goal: readCodexGoal(session, [root]),
    });
    const roster = await captain.serveOperatorConversation({
      op: "roster",
      schemaVersion: 1,
      includeWork: true,
    });
    expect(roster.op === "roster" && roster.seats[0]?.goal).toEqual(response.snapshot.seats[0]?.goal);
    expect(shell).toHaveBeenCalledTimes(1);
    const legacy = await captain.serveOperatorConversation({ op: "fleet", schemaVersion: 1 });
    expect(legacy.op === "fleet" && legacy.snapshot.seats[0]?.goal).toBeUndefined();
    expect(herdr.mock.calls.every(([args]) => ["agent list", "api snapshot"].includes(args.join(" ")))).toBe(
      true,
    );
  } finally {
    await captain.close();
  }
});

const objectiveLimit = 16_384;
const crossBoundObjectives = [
  {
    name: "quoted credential",
    objective: "x".repeat(objectiveLimit - 26) + ' password: "FAKE ONE TWO THREE FOUR FIVE SIX"',
  },
  {
    name: "provider-shaped credential",
    objective: "x".repeat(objectiveLimit - 8) + " sk-FAKE_ONLY_SYNTHETIC_TOKEN",
  },
];

it.each(crossBoundObjectives)(
  "local SQLite reader redacts a complete $name before bounding",
  ({ objective }) => {
    const home = scratch();
    const db = store(home);
    try {
      db.prepare("UPDATE thread_goals SET objective = ? WHERE thread_id = ?").run(objective, id);
      const before = readFileSync(join(home, "goals_1.sqlite"));
      const goal = readCodexGoal(session, [home]);
      expect(goal).toBeDefined();
      expect(goal!.objective).toContain("[REDACT");
      expect(goal!.objective).not.toContain("FAKE");
      expect(goal!.objective).not.toContain("ONE TWO");
      expect(goal!.objective.length).toBeLessThanOrEqual(objectiveLimit);
      expect(readFileSync(join(home, "goals_1.sqlite"))).toEqual(before);
    } finally {
      db.close();
    }
  },
);

it.each([
  ...crossBoundObjectives,
  { name: "embedded NUL credential", objective: 'Task password: "FAKE\0ONE TWO THREE"' },
  {
    name: "Unicode over-bound credential",
    objective: "😀".repeat(objectiveLimit - 8) + " sk-FAKE_ONLY_SYNTHETIC_TOKEN",
  },
])("remote SQLite command treats $name as unknown and retains the safe cache", async ({ objective }) => {
  const home = scratch();
  const db = store(home);
  const shell = localShell(home);
  let now = 0;
  const project = createRemoteCodexGoals({ shell: () => shell, now: () => now });
  try {
    const safe = (await project([seat], [observed], [fleet]))[0]?.goal;
    expect(safe).toBeDefined();
    db.prepare("UPDATE thread_goals SET objective = ?, updated_at_ms = ? WHERE thread_id = ?").run(
      objective,
      row.updated_at_ms + 1000,
      id,
    );
    const before = readFileSync(join(home, "goals_1.sqlite"));
    now += 10_000;
    expect((await project([seat], [observed], [fleet]))[0]?.goal).toEqual(safe);
    const response = await shell.mock.results.at(-1)!.value;
    expect(JSON.parse(response)).toEqual([
      [id, { ...row, objective: null, updated_at_ms: row.updated_at_ms + 1000 }],
    ]);
    expect(Buffer.byteLength(response, "utf8")).toBeLessThan(1000);
    expect(response).not.toContain("FAKE");
    const cold = createRemoteCodexGoals({ shell: () => shell });
    expect((await cold([seat], [observed], [fleet]))[0]?.goal).toBeUndefined();
    expect(readFileSync(join(home, "goals_1.sqlite"))).toEqual(before);
  } finally {
    db.close();
  }
});

it.each([
  {
    name: "short quoted credential",
    objective: 'Task password: "FAKE ONE TWO THREE FOUR FIVE SIX"',
    expected: "Task [REDACTED]",
  },
  {
    name: "short provider-shaped credential",
    objective: "Task sk-FAKE_ONLY_SYNTHETIC_TOKEN",
    expected: "Task [REDACTED]",
  },
  {
    name: "Unicode credential across the JS projection bound",
    objective: "😀".repeat((objectiveLimit - 26) / 2) + ' password: "FAKE ONE TWO THREE FOUR FIVE SIX"',
    expected: "😀".repeat((objectiveLimit - 26) / 2) + " [REDACTED]",
  },
  {
    name: "complete ASCII exact-bound objective",
    objective: "x".repeat(objectiveLimit),
    expected: "x".repeat(objectiveLimit),
  },
  {
    name: "complete Unicode exact-bound objective",
    objective: "😀".repeat(objectiveLimit - 36) + ' password: "FAKE ONE TWO THREE FOUR"',
    expected: "😀".repeat(objectiveLimit / 2),
  },
])("local and actual remote readers preserve $name", async ({ objective, expected }) => {
  const home = scratch();
  const db = store(home);
  const shell = localShell(home);
  const project = createRemoteCodexGoals({ shell: () => shell });
  try {
    db.prepare("UPDATE thread_goals SET objective = ? WHERE thread_id = ?").run(objective, id);
    const local = readCodexGoal(session, [home]);
    const remote = (await project([seat], [observed], [fleet]))[0]?.goal;
    expect(local?.objective).toBe(expected);
    expect(remote).toEqual(local);
    expect(remote?.objective).not.toContain("FAKE");
    const response = JSON.parse(await shell.mock.results.at(-1)!.value);
    expect(response[0][1].objective).toBe(objective); // Complete raw syntax reaches the existing redactor.
  } finally {
    db.close();
  }
});
