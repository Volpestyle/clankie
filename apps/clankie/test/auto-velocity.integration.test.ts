import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ProjectSchema } from "@clankie/protocol/projects";
import { createLocalTracker, TRACKER_LEAD, TRACKER_OWNER, type TrackerActor } from "@clankie/work-items";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { AutoRoundsResponseSchema } from "@clankie/protocol/auto-rounds";
import { afterEach, expect, it } from "vitest";
import { runConversationsCommand } from "../../tui/src/command/conversations.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { AutoRoundRecord } from "../src/captain/auto-rounds.ts";
import { autoRoundPrompt } from "../src/captain/auto-projects.ts";
import { measureVelocity, velocityLine } from "../src/captain/auto-velocity.ts";
import { ProjectMirrors } from "../src/captain/project-mirrors.ts";
import { readRepositoryChurn } from "../src/captain/repository-churn.ts";
import { readProjectOutcomes } from "../src/project-outcomes.ts";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const lead: TrackerActor = { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] };
const owner: TrackerActor = { ...TRACKER_OWNER, onBehalfOf: [] };

it("measures a project's velocity from its built-in tracker and origin, and keeps the round record", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "auto-velocity-")));
  roots.push(root);

  // Tracker: a parent closed on 10-11 (the milestone), then three closures and one started issue.
  let clock = new Date("2026-10-08T15:00:00.000Z");
  const tracker = createLocalTracker({
    directory: join(root, "tracker"),
    clock: () => clock,
    // Host evidence validation, reduced to the one fixture record this test attaches.
    validateEvidence: async (_key, references) => {
      if (references.some((reference) => reference.recordId !== "fixture"))
        throw new Error("Unknown evidence");
    },
  });
  const call = (name: string, args: Record<string, unknown>, actor = lead) =>
    tracker.call(name, args, { actor });
  const at = async (iso: string, step: () => Promise<unknown>) => {
    clock = new Date(iso);
    return step();
  };
  const trackerProject = (await call("save_project", { name: "Mod", addTeams: ["LOCAL"] })) as { id: string };
  const issue = async (title: string, parentId?: string) =>
    (await call("save_issue", {
      team: "LOCAL",
      project: trackerProject.id,
      title,
      ...(parentId === undefined ? {} : { parentId }),
    })) as { id: string; identifier: string };
  const close = async (target: { id: string }) => {
    await call("post_issue_event", { issueId: target.id, type: "result", stage: "landed" });
    await call("save_evidence_bundle", {
      issueId: target.id,
      references: [
        {
          recordId: "fixture",
          sha256: "0".repeat(64),
          url: `clankie://evidence/sha256/${"0".repeat(64)}`,
          type: "log",
        },
      ],
      gaps: [],
    });
    await call("save_issue", { id: target.id, state: "Done" }, owner);
  };
  const parent = await issue("Milestone: playable route");
  const child = await issue("Route step", parent.id);
  const product = await issue("Party menu hook");
  const rig = await issue("Rig runner");
  const quiet = await issue("Config cleanup");
  const started = await issue("Boss sync");
  await at("2026-10-11T16:00:00.000Z", () => close(child));
  await at("2026-10-11T17:00:00.000Z", () => close(parent));
  await at("2026-10-12T15:00:00.000Z", () => call("save_issue", { id: started.id, state: "In Progress" }));
  await at("2026-10-13T15:00:00.000Z", () => close(product));
  await at("2026-10-13T16:00:00.000Z", () => close(rig));
  await at("2026-10-13T17:00:00.000Z", () => close(quiet));

  // Origin: the product issue's commit touches product code, the rig issue's only tooling.
  const workspace = join(root, "work");
  const origin = join(root, "origin.git");
  await exec("git", ["init", "-q", "--bare", "-b", "main", origin]);
  await exec("git", ["init", "-q", "-b", "main", workspace]);
  const git = (when: string, ...args: string[]) =>
    exec(
      "git",
      ["-C", workspace, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args],
      {
        env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
      },
    );
  const commit = async (when: string, message: string, files: Record<string, number>) => {
    for (const [path, lines] of Object.entries(files)) {
      await mkdir(dirname(join(workspace, path)), { recursive: true });
      await writeFile(join(workspace, path), Array.from({ length: lines }, (_, n) => `line ${n}\n`).join(""));
    }
    await git(when, "add", ".");
    await git(when, "commit", "-q", "-m", message);
  };
  await git("2026-10-08T00:00:00Z", "remote", "add", "origin", origin);
  await commit("2026-10-08T15:00:00Z", "Scaffold", { "src/main.cpp": 2 });
  await commit("2026-10-12T15:00:00Z", `Hook the party menu (${product.identifier})`, { "src/menu.cpp": 10 });
  await commit("2026-10-13T14:00:00Z", `Rig runner (${rig.identifier})`, {
    "tools/rig/run.ps1": 30,
    "tests/rig.test.ts": 5,
  });
  await commit("2026-10-13T18:00:00Z", "Guide", { "docs/guide.md": 4 });
  await git("2026-10-13T18:00:00Z", "push", "-q", "origin", "main");
  await git("2026-10-13T18:00:00Z", "fetch", "-q", "origin");
  await git("2026-10-13T18:00:00Z", "remote", "set-head", "origin", "main");

  const project = ProjectSchema.parse({
    id: "mod",
    name: "Mod",
    workspaces: [{ id: "work", machineId: "local", path: workspace, platform: "posix" }],
    trackerProjectId: trackerProject.id,
    auto: true,
  });
  const routes: string[] = [];
  const deps = {
    outcomes: (
      target: typeof project,
      input: { window: { since: string; until: string }; history: boolean },
    ) =>
      readProjectOutcomes(target, input, {
        route: async (projectId: string) => {
          routes.push(projectId);
          return "project:mod";
        },
        linearQuery: () => Promise.reject(new Error("not Linear")),
        builtIn: tracker,
      }),
    history: (target: typeof project) =>
      new ProjectMirrors(join(root, "mirrors"), () => Promise.reject(new Error("local only"))).history(
        target,
      ),
    churn: readRepositoryChurn,
    timeZone: "America/Chicago",
  };
  const now = new Date("2026-10-14T03:00:00.000Z");
  const velocity = await measureVelocity(project, null, deps, now);

  expect(routes).toEqual(["mod"]);
  expect(velocity.lastMilestone).toMatchObject({ kind: "parent", ref: parent.identifier });
  expect(velocity.window).toMatchObject({ from: "milestone", until: now.toISOString() });
  expect(velocity.window.since.startsWith("2026-10-11T17:00")).toBe(true);
  // Since the milestone: one product closure, one tooling, one with no commit (owner-facing, unlinked).
  expect(velocity.closures).toEqual({
    state: "known",
    ownerFacing: [product.identifier],
    tooling: [rig.identifier],
    unlinked: [quiet.identifier],
    unclassified: [],
  });
  expect(velocity.started).toEqual({ state: "known", total: 1, byState: { "In Progress": 1 }, cap: null });
  expect(velocity.churn).toEqual({
    state: "known",
    lines: { product: 10, tooling: 35, docs: 4, excluded: 0 },
    commits: 3,
  });
  const byDate = Object.fromEntries(velocity.days.map((day) => [day.date, day]));
  // Days cover the last seven local days, not just the hours since the milestone.
  expect(velocity.days[0]!.date).toBe("2026-10-07");
  expect(byDate["2026-10-09"]).toMatchObject({ inWindow: false, working: false });
  // The milestone day: child and parent closed with no commit naming them.
  expect(byDate["2026-10-11"]).toMatchObject({ inWindow: true, working: true, closed: { unlinked: 2 } });
  expect(byDate["2026-10-13"]).toMatchObject({
    inWindow: true,
    working: true,
    lines: { product: 0, tooling: 35, docs: 4, excluded: 0 },
    closed: { ownerFacing: 1, tooling: 1, unlinked: 1 },
  });
  const line = velocityLine(velocity);
  expect(line).toBe(
    `Mod: since milestone ${parent.identifier} (${velocity.window.since.slice(0, 16)}Z), closed 3: 2 owner-facing (1 unlinked), 1 tooling; 1 started (no WIP cap); churn product 10, tooling 35, docs 4 lines over 3 working days.`,
  );
  expect(autoRoundPrompt([], [line])).toContain(`- ${line}`);

  // The record survives a restart: measurement first, delivery after, milestone kept.
  const record = new AutoRoundRecord(join(root, "auto-rounds"));
  const roundId = record.measured("global-default", [velocity], now);
  record.settled(roundId, true, undefined, now);
  const restarted = new AutoRoundRecord(join(root, "auto-rounds"));
  expect(restarted.lastMilestone("mod")).toEqual(velocity.lastMilestone);
  const lines = (await readFile(join(root, "auto-rounds", "rounds.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((entry) => JSON.parse(entry) as Record<string, unknown>);
  expect(lines.map((entry) => [entry.type, entry.roundId])).toEqual([
    ["measurement", roundId],
    ["delivery", roundId],
  ]);
  expect(lines[1]).toMatchObject({ delivered: true });

  // A project with no readable tracker or history still measures, as unknown.
  const unknown = await measureVelocity(
    { ...project, trackerProjectId: undefined, workspaces: [] },
    null,
    deps,
    now,
  );
  expect(unknown.closures.state).toBe("unknown");
  expect(unknown.churn.state).toBe("unknown");
  expect(velocityLine(unknown)).toContain("closures unknown (");
});

it("serves the round record through the operator route and `clankie auto rounds`", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "auto-rounds-")));
  roots.push(root);
  const project = (id: string) => ProjectSchema.parse({ id, name: id, workspaces: [], auto: true });
  const deps = {
    outcomes: async () => ({ state: "unavailable" as const, reason: "no tracker bound" }),
    history: async () => ({ state: "unknown" as const, reason: "project has no workspace" }),
    churn: readRepositoryChurn,
    timeZone: "America/Chicago",
  };
  const now = new Date("2026-10-14T03:00:00.000Z");
  const record = new AutoRoundRecord(join(root, "auto-rounds"));
  const first = record.measured(
    "lead",
    [
      await measureVelocity(project("kh2"), null, deps, now),
      await measureVelocity(project("app"), null, deps, now),
    ],
    now,
  );
  record.settled(first, true, undefined, now);
  // The second round never settled (a restart mid-wake).
  const second = record.measured("lead", [await measureVelocity(project("kh2"), null, deps, now)], now);

  const service = await createClankieApp({
    captain: createStubCaptain(),
    autoRounds: new AutoRoundRecord(join(root, "auto-rounds")),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer rounds-owner"
        ? { operatorId: "rounds-owner" }
        : undefined,
  });
  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => service.app.fetch(request),
  }) as Server;
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing rounds server");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    expect((await fetch(`${origin}/v1/auto/rounds`)).status).toBe(401);
    let written = "";
    const env = {
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "config"),
      PATH: "",
      CLANKIE_STATE: join(root, "state"),
      CLANKIE_OPERATOR_TOKEN: "rounds-owner",
      CLANKIE_CONTROL_PLANE_URL: origin,
    };
    const stdout = { write: (chunk: string) => ((written += chunk), true) };
    expect(await runConversationsCommand(["auto", "rounds", "--project", "kh2"], { env, stdout })).toBe(0);
    const all = AutoRoundsResponseSchema.parse(JSON.parse(written));
    expect(
      all.rounds.map((round) => [round.roundId, round.delivery?.delivered ?? null, round.projects.length]),
    ).toEqual([
      [second, null, 1],
      [first, true, 1],
    ]);
    expect(all.rounds[1]!.projects[0]).toMatchObject({
      projectId: "kh2",
      closures: { state: "unknown", reason: "no tracker bound" },
      churn: { state: "unknown", reason: "project has no workspace" },
    });
    written = "";
    expect(await runConversationsCommand(["auto", "rounds", "--limit", "1"], { env, stdout })).toBe(0);
    expect(AutoRoundsResponseSchema.parse(JSON.parse(written)).rounds.map((round) => round.roundId)).toEqual([
      second,
    ]);
    await expect(runConversationsCommand(["auto", "rounds", "--since"], { env, stdout })).rejects.toThrow(
      "Usage: clankie auto",
    );
  } finally {
    service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
