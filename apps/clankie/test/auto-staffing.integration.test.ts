import { serve } from "@hono/node-server";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { runConversationsCommand } from "../../tui/src/command/conversations.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AutoRoundsResponseSchema } from "@clankie/protocol/auto-rounds";
import { ProjectSchema } from "@clankie/protocol/projects";
import { createLocalTracker, TRACKER_LEAD, TRACKER_OWNER } from "@clankie/work-items";
import {
  autoPlanCapacity,
  projectStaffing,
  staffingSection,
  staffingSignals,
  staffingTotals,
} from "../src/captain/auto-staffing.ts";
import { AutoRoundRecord } from "../src/captain/auto-rounds.ts";
import { autoRoundDue, autoRoundFingerprint } from "../src/captain/auto-projects.ts";
import { measureVelocity } from "../src/captain/auto-velocity.ts";
import { readProjectWorkQueue } from "../src/project-work-queue.ts";
import type { MachineWorkerAccounts } from "../src/captain/harness-accounts.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const at = new Date("2026-10-17T03:00:00.000Z");
// VUH-2335's recorded overnight window: 1/33 working, 58% Max week with
// 3.9 days to reset, 80% Pro week with 5.2 days. No raw historical census is
// claimed: idle statuses and project roots below are explicit replay inputs.
const accounts: MachineWorkerAccounts = {
  machine: "local",
  shell: "posix",
  observedAt: at.toISOString(),
  accounts: [
    {
      harness: "claude",
      label: "default",
      home: "/fixture/.claude",
      signedIn: true,
      usable: true,
      headroom: 0.58,
      tier: "default_claude_max_20x",
      usage: {
        observedAt: at.toISOString(),
        source: "claude-usage",
        windows: [
          {
            id: "week",
            label: "Week",
            usedPercent: 42,
            windowMinutes: 10080,
            resetsAt: new Date(+at + 3.9 * 86400000).toISOString(),
          },
        ],
      },
    },
    {
      harness: "codex",
      label: "default",
      home: "/fixture/.codex",
      signedIn: true,
      usable: true,
      headroom: 0.8,
      plan: "pro",
      usage: {
        observedAt: at.toISOString(),
        source: "codex-rate-limits",
        windows: [
          {
            id: "week",
            label: "Week",
            usedPercent: 20,
            windowMinutes: 10080,
            resetsAt: new Date(+at + 5.2 * 86400000).toISOString(),
          },
        ],
      },
    },
  ],
};

it("replays the 10-17 overnight capacity fault, retains its record, and verifies staffing next round", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-staffing-"));
  roots.push(root);
  const tracker = createLocalTracker({ directory: join(root, "tracker"), clock: () => at });
  const actor = { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] };
  const call = (name: string, args: Record<string, unknown>) => tracker.call(name, args, { actor });
  const tracked = (await call("save_project", { name: "Clankie", addTeams: ["LOCAL"] })) as { id: string };
  const create = async (title: string, state = "Todo") =>
    (await call("save_issue", { team: "LOCAL", project: tracked.id, title, state })) as {
      id: string;
      identifier: string;
    };
  const ready = await create("Remote report proof");
  const blocked = await create("Owner-only setup");
  const downstream = await create("Needs owner setup");
  await call("save_issue", { id: downstream.id, blockedBy: [blocked.id] });
  await call("post_issue_event", { issueId: blocked.id, type: "blocked", body: "Owner must sign in" });
  const project = ProjectSchema.parse({
    id: "core",
    name: "Clankie",
    auto: true,
    trackerProjectId: tracked.id,
    workspaces: [{ id: "core-work", machineId: "local", platform: "posix", path: "/fixture/core" }],
    workerCap: 33,
    wipCap: 40,
  });
  const queue = await readProjectWorkQueue(project, {
    route: async () => root,
    linearQuery: async () => {
      throw new Error("Must use saved built-in route");
    },
    builtIn: tracker,
  });
  expect(queue.state).toBe("known");
  if (queue.state !== "known") throw new Error(queue.reason);
  expect(queue.ready).toContain(ready.identifier);
  expect(queue.ready).not.toContain(blocked.identifier);
  expect(queue.ready).not.toContain(downstream.identifier);
  expect(queue.blocked).toContainEqual(
    expect.objectContaining({ issue: blocked.identifier, blocks: [downstream.identifier] }),
  );
  const velocity = await measureVelocity(
    project,
    null,
    {
      outcomes: async (_p, input) => ({
        state: "read",
        outcomes: await tracker.readOutcomes({ projectId: tracked.id, ...input }),
      }),
      history: async () => ({ state: "unknown", reason: "No git in replay" }),
      churn: async () => {
        throw new Error("No git in replay");
      },
      timeZone: "UTC",
    },
    at,
  );
  const seats = Array.from({ length: 33 }, (_, n) => ({
    machine: "local",
    directory: "/fixture/core",
    status: n === 0 ? "working" : "idle",
  }));
  const plans = autoPlanCapacity([accounts], +at);
  expect(plans.every((plan) => plan.state === "headroom")).toBe(true);
  const measured = {
    ...velocity,
    staffing: projectStaffing({ project, queue, seats, plans, started: velocity.started }),
  };
  expect(measured.staffing).toMatchObject({ activeSeats: 1, idleSeats: 32, signal: "under_staffed" });
  expect(staffingSection([measured]).join("\n")).toContain("Staff ready work now");
  const record = new AutoRoundRecord(join(root, "rounds"));
  const id = record.measured("lead", [measured], at, staffingTotals([measured], plans));
  record.settled(id, true, undefined, at);
  const previous = new AutoRoundRecord(join(root, "rounds")).read()[0]!;
  expect(
    AutoRoundsResponseSchema.parse({ schemaVersion: 1, rounds: [previous] }).rounds[0]!.staffing,
  ).toMatchObject({ activeSeats: 1, idleSeats: 32, readyIssues: 1 });
  const service = await createClankieApp({
    captain: createStubCaptain(),
    autoRounds: record,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer staffing-owner"
        ? { operatorId: "staffing-owner" }
        : undefined,
  });
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => service.app.fetch(request) });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture server");
    const origin = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${origin}/v1/auto/rounds`)).status).toBe(401);
    const legacy = (await (
      await fetch(`${origin}/v1/auto/rounds?includeWorkPolicy=true`, {
        headers: { authorization: "Bearer staffing-owner" },
      })
    ).json()) as { rounds: { staffing?: unknown; projects: { staffing?: unknown }[] }[] };
    expect(legacy.rounds[0]!.staffing).toBeUndefined();
    expect(legacy.rounds[0]!.projects[0]!.staffing).toBeUndefined();
    let output = "";
    expect(
      await runConversationsCommand(["auto", "rounds", "--project", project.id], {
        env: {
          HOME: join(root, "home"),
          PATH: "",
          CLANKIE_STATE: join(root, "state"),
          CLANKIE_OPERATOR_TOKEN: "staffing-owner",
          CLANKIE_CONTROL_PLANE_URL: origin,
        },
        stdout: {
          write: (chunk) => {
            output += chunk;
            return true;
          },
        },
      }),
    ).toBe(0);
    const delivered = AutoRoundsResponseSchema.parse(JSON.parse(output));
    expect(delivered.rounds[0]!.staffing?.readyIssues).toBe(1);
    expect(delivered.rounds[0]!.projects[0]!.staffing?.signal).toBe("under_staffed");
  } finally {
    service.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
  }
  const unresolved = projectStaffing({ project, queue, seats, plans, started: velocity.started, previous });
  expect(unresolved.check?.state).toBe("unresolved");
  const states = [{ id: project.id, name: project.name, workers: 33 }];
  const before = autoRoundFingerprint(states, () => staffingSignals(measured.staffing));
  const after = autoRoundFingerprint(states, () => staffingSignals(unresolved));
  expect(autoRoundDue(after, { fingerprint: before, at: +at }, +at + 1800000)).toBe(true);
  const staffed = projectStaffing({
    project,
    queue,
    seats: seats.map((s, i) => (i < 2 ? { ...s, status: "working" } : s)),
    plans,
    started: velocity.started,
    previous,
  });
  expect(staffed.check?.state).toBe("staffed");
  expect(
    projectStaffing({
      project: { ...project, wipCap: 1 },
      queue,
      seats,
      plans,
      started: { state: "known", total: 1, byState: { "In Progress": 1 }, cap: 1 },
      previous,
    }).check?.state,
  ).toBe("cap_reached");
  expect(
    projectStaffing({
      project,
      queue: { ...queue, ready: [] },
      seats,
      plans,
      started: velocity.started,
      previous,
    }).check?.state,
  ).toBe("no_ready_work");
  const capped = projectStaffing({
    project: { ...project, workerCap: 0 },
    queue,
    seats,
    plans,
    started: velocity.started,
    previous,
  });
  expect(capped.signal).toBeNull();
  expect(capped.check?.state).toBe("cap_reached");
  const unobserved = projectStaffing({
    project,
    queue,
    seats: [],
    plans,
    started: velocity.started,
    unavailableMachines: new Set(["local"]),
    previous,
  });
  expect(unobserved).toMatchObject({
    activeSeats: null,
    occupiedSeats: null,
    signal: null,
    reason: "unknown",
  });
  const reserve = plans.map((plan) => ({ ...plan, state: "reserve" as const }));
  expect(
    projectStaffing({ project, queue, seats, plans: reserve, started: velocity.started, previous }).check
      ?.state,
  ).toBe("plan_reserve");
  const empty = projectStaffing({
    project,
    queue: { ...queue, ready: [] },
    seats,
    plans,
    started: velocity.started,
  });
  expect(empty.signal).toBe("backlog_not_ready");
  expect(staffingSection([{ ...velocity, staffing: empty }]).join("\n")).toContain("Plan backlog items");
});

it("never treats stale, held, signed-out, reset or unknown usage as hiring headroom", () => {
  expect(autoPlanCapacity([accounts], +at + 6 * 60000).every((plan) => plan.state === "unknown")).toBe(true);
  const report = (patch: Partial<MachineWorkerAccounts["accounts"][number]>) => ({
    ...accounts,
    accounts: accounts.accounts.map((a) => ({ ...a, ...patch })),
  });
  expect(
    autoPlanCapacity([report({ held: { reason: "Owner hold" } })], +at).every(
      (plan) => plan.state === "held",
    ),
  ).toBe(true);
  expect(
    autoPlanCapacity([report({ signedIn: false })], +at).every((plan) => plan.state === "unavailable"),
  ).toBe(true);
  const missing = {
    ...accounts,
    accounts: accounts.accounts.map(({ usage: _usage, ...account }) => account),
  };
  expect(autoPlanCapacity([missing], +at).every((plan) => plan.state === "unknown")).toBe(true);
  const expired = {
    ...accounts,
    accounts: accounts.accounts.map((account) => ({
      ...account,
      usage: {
        ...account.usage!,
        windows: account.usage!.windows.map((window) => ({
          ...window,
          resetsAt: new Date(+at - 1).toISOString(),
        })),
      },
    })),
  };
  const readings = autoPlanCapacity([expired], +at);
  expect(readings.every((plan) => plan.state === "unknown")).toBe(true);
  expect(readings[0]!.windows[0]!.left).toBeCloseTo(0.58);
});

it("pages the connected project's blocker graph without letting an owner blocker hide unrelated ready work", async () => {
  const edge = {
    id: "edge",
    type: "blocks",
    issue: { id: "owner", identifier: "VUH-1", state: { type: "unstarted" } },
    relatedIssue: { id: "child", identifier: "VUH-2", state: { type: "unstarted" } },
  };
  const connection = (nodes: unknown[], next = false, cursor: string | null = null) => ({
    nodes,
    pageInfo: { hasNextPage: next, endCursor: cursor },
  });
  const issue = (
    id: string,
    identifier: string,
    labels: string[],
    relations: unknown[] = [],
    inverse: unknown[] = [],
  ) => ({
    id,
    identifier,
    state: { name: "Todo", type: "unstarted" },
    labels: connection(labels.map((name) => ({ name }))),
    relations: connection(relations),
    inverseRelations: connection(inverse),
  });
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as { variables: { id: string; after: string | null } };
      if (body.variables.id !== "11111111-1111-4111-8111-111111111111")
        return Response.json({ error: "Wrong project" }, { status: 403 });
      const data =
        body.variables.after === null
          ? connection(
              [issue("owner", "VUH-1", ["Needs owner"], [edge]), issue("child", "VUH-2", [], [], [edge])],
              true,
              "next",
            )
          : connection([issue("ready", "VUH-3", [])]);
      return Response.json({ data: { project: { issues: data } } });
    },
  });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture server");
    const project = ProjectSchema.parse({
      id: "remote",
      name: "Remote",
      workspaces: [],
      linearProjectBinding: { provider: "linear", projectId: "11111111-1111-4111-8111-111111111111" },
    });
    const query = async (text: string, variables: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${address.port}`, {
        method: "POST",
        body: JSON.stringify({ query: text, variables }),
      });
      if (!response.ok) throw new Error("Provider refused");
      return ((await response.json()) as { data: Record<string, unknown> }).data;
    };
    const queue = await readProjectWorkQueue(project, {
      route: async () => undefined,
      linearQuery: async () => query,
      builtIn: {
        readWorkQueue: async () => {
          throw new Error("Wrong backend");
        },
      },
    });
    expect(queue).toEqual({
      state: "known",
      ready: ["VUH-3"],
      backlog: [],
      blocked: [
        { issue: "VUH-1", blocks: ["VUH-2"], reason: "owner dependency" },
        { issue: "VUH-2", blocks: [], reason: "blocked by VUH-1" },
      ],
    });
    const unavailable = await readProjectWorkQueue(project, {
      route: async () => undefined,
      linearQuery: async () => async () => {
        throw new Error("Provider unavailable");
      },
      builtIn: {
        readWorkQueue: async () => {
          throw new Error("Wrong backend");
        },
      },
    });
    expect(unavailable).toEqual({ state: "unknown", reason: "Provider unavailable" });
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
  }
});
