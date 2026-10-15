import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ProjectSchema } from "@clankie/protocol/projects";
import {
  collectLinearOutcomes,
  createLocalTracker,
  TRACKER_LEAD,
  TRACKER_OWNER,
  type TrackerActor,
} from "@clankie/work-items";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { AutoRoundsResponseSchema } from "@clankie/protocol/auto-rounds";
import { afterEach, expect, it } from "vitest";
import { runConversationsCommand } from "../../tui/src/command/conversations.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { milestoneSignals, reportingSection } from "../src/captain/auto-reporting.ts";
import { AutoRoundRecord } from "../src/captain/auto-rounds.ts";
import { AutoRoundCadence } from "../src/captain/auto-cadence.ts";
import {
  autoRoundDue,
  autoRoundFingerprint,
  autoRoundPrompt,
  type AutoProjectState,
} from "../src/captain/auto-projects.ts";
import { driftSection, driftSignals, withDrift } from "../src/captain/auto-drift.ts";
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

/** A real built-in tracker and origin: a parent milestone on 10-11, then product, tooling and unlinked closures. */
async function measuredProject() {
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
  return { project, deps, routes, parent, product, rig, quiet, commit, git, call, at, trackerProject };
}

it("measures a project's velocity from its built-in tracker and origin, and keeps the round record", async () => {
  const { project, deps, routes, parent, product, rig, quiet } = await measuredProject();
  const root = roots.at(-1)!;
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

it("recovers delivery fences from the durable round journal after interrupted settlement", async () => {
  const { project, deps } = await measuredProject();
  const root = roots.at(-1)!;
  const record = new AutoRoundRecord(join(root, "rounds"));
  const velocity = await measureVelocity(project, null, deps, new Date("2026-10-15T05:00:00Z"));
  const open = () => new AutoRoundCadence(join(root, "rounds"), 30 * 60_000, () => record.read());
  const now = Date.now();
  const fingerprint = "unchanged-evidence";
  const original = open();
  const pending = record.measured("lead", [velocity]);
  original.claim("lead", pending, fingerprint, now);
  // A native send with unknown acceptance must not be sent again on a quick restart.
  const restarted = open();
  let stop = restarted.start(async () => {});
  expect(autoRoundDue(fingerprint, restarted.last("lead"), now + 1_000)).toBe(false);
  expect(autoRoundDue(fingerprint, restarted.last("lead"), now + 2 * 60 * 60_000)).toBe(true);
  stop();
  // The journal may settle before the runtime manages to save its accepted fingerprint.
  record.settled(pending, true, undefined, new Date(now + 100));
  const recovered = open();
  stop = recovered.start(async () => {});
  expect(recovered.last("lead")).toEqual({ fingerprint, at: now + 100 });
  stop();
  const next = record.measured("lead", [velocity]);
  recovered.claim("lead", next, "changed-evidence", now + 200);
  original.settled("lead", pending, false);
  expect(open().last("lead")).toMatchObject({ fingerprint: "changed-evidence", at: now + 200 });
  record.settled(next, false);
  const refused = open();
  stop = refused.start(async () => {});
  expect(refused.last("lead")).toEqual({ fingerprint, at: now + 100 });
  expect(autoRoundDue("changed-evidence", refused.last("lead"), now + 300)).toBe(true);
  stop();
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

it("names drift from completed working days, carries it until a round is delivered, and fingerprints the signal set", async () => {
  const { project, deps, product, commit, git } = await measuredProject();
  const root = roots.at(-1)!;
  // 10-12 also lands tests heavier than its product change, so tooling leads two working days running.
  await commit("2026-10-12T16:00:00Z", `Menu tests (${product.identifier})`, { "tests/menu.test.ts": 20 });
  await git("2026-10-13T18:30:00Z", "push", "-q", "origin", "main");
  await git("2026-10-13T18:30:00Z", "fetch", "-q", "origin");
  const record = new AutoRoundRecord(join(root, "auto-rounds"));

  // Late on 10-13 (CDT): 10-12 is the last completed working day; it closed nothing owner-facing.
  const evening = withDrift(
    await measureVelocity(project, null, deps, new Date("2026-10-14T03:00:00.000Z")),
    [],
  );
  expect(evening.drift).toEqual([
    { signal: "nothing_closed", day: "2026-10-12", numbers: { tooling: 0, stateChanges: 1 } },
  ]);
  // Its wake is refused (a limited lead seat), so the detection stays pending.
  record.settled(record.measured("lead", [evening]), false, "lead seat limited");
  expect(record.pendingDrift("mod")).toEqual(evening.drift);

  // 10-14: 10-12 and 10-13 both led with tooling; 10-13 closed owner-facing work. The undelivered
  // nothing_closed rides along, marked carried.
  const next = withDrift(
    await measureVelocity(project, record.lastMilestone("mod"), deps, new Date("2026-10-14T18:00:00.000Z")),
    record.pendingDrift("mod"),
  );
  expect(next.drift).toEqual([
    {
      signal: "tooling_lead",
      day: "2026-10-13",
      numbers: {
        product: 0,
        tooling: 35,
        docs: 4,
        previousProduct: 10,
        previousTooling: 20,
        previousDocs: 0,
      },
    },
    { signal: "nothing_closed", day: "2026-10-12", numbers: { tooling: 0, stateChanges: 1 }, carried: true },
  ]);
  // over_wip needs a WIP cap; none exists until VUH-2256.
  expect(next.drift!.some((detection) => detection.signal === "over_wip")).toBe(false);

  const section = driftSection([next]).join("\n");
  expect(section).toContain(
    "Mod: tooling_lead. Tooling and docs churn outran product on the last two working days",
  );
  expect(section).toContain(
    "Stop starting tooling work on this project, then pick the next milestone feature and staff it.",
  );
  expect(section).toContain("Mod: nothing_closed (carried from an undelivered round). 2026-10-12");
  const state: AutoProjectState = { id: "mod", name: "Mod", workers: 0 };
  expect(autoRoundPrompt([state], [], driftSection([next]))).toContain(section);

  // New drift changes the fingerprint; the same signals with other numbers do not.
  const quiet = autoRoundFingerprint([state]);
  const drifting = autoRoundFingerprint([state], () => driftSignals(next));
  expect(drifting).not.toBe(quiet);
  const sameSignals = { ...next, drift: next.drift!.map((detection) => ({ ...detection, numbers: {} })) };
  expect(autoRoundFingerprint([state], () => driftSignals(sameSignals))).toBe(drifting);

  // A delivered round clears exactly what it carried.
  record.settled(record.measured("lead", [next]), true);
  expect(record.pendingDrift("mod")).toEqual([]);
  expect(
    new AutoRoundRecord(join(root, "auto-rounds")).read({ projectId: "mod", limit: 1 })[0]!.projects[0]!
      .drift,
  ).toEqual(next.drift);
});

it("uses declared product paths for both churn and closure classification", async () => {
  const { project, deps, product, rig } = await measuredProject();
  const velocity = await measureVelocity(
    { ...project, productPaths: ["tools/"] },
    null,
    deps,
    new Date("2026-10-14T03:00:00.000Z"),
  );
  expect(velocity.closures).toMatchObject({
    state: "known",
    ownerFacing: [rig.identifier],
    tooling: [product.identifier],
  });
  expect(velocity.churn).toMatchObject({
    state: "known",
    lines: { product: 30, tooling: 15, docs: 4, excluded: 0 },
  });
});

it("requests one milestone post, links the real tracker update after restart, and flags routine extras", async () => {
  const { project, deps, call, at, trackerProject, parent } = await measuredProject();
  const directory = join(roots.at(-1)!, "reporting");
  let record = new AutoRoundRecord(directory);
  const now = new Date("2026-10-14T03:00:00.000Z");
  const velocity = await measureVelocity(project, null, deps, now);
  const first = record.withReporting(velocity);
  expect(first.report!.milestones).toMatchObject([{ kind: "parent", ref: parent.identifier }]);
  expect(reportingSection([first]).join("\n")).toContain("Post exactly one project status update");
  expect(reportingSection([first]).join("\n")).toContain("with media and evidence links");
  const roundId = record.measured("lead", [first], now);
  record.settled(roundId, true, undefined, now);
  record = new AutoRoundRecord(directory);
  const routine = record.withReporting(
    await measureVelocity(project, record.lastMilestone(project.id), deps, new Date("2026-10-14T04:00:00Z")),
  );
  expect(routine.report!.milestones).toEqual([]);
  expect(reportingSection([routine]).join("\n")).toContain("Do not post a project status update");
  const routineId = record.measured("lead", [routine], new Date("2026-10-14T04:00:00Z"));
  record.settled(routineId, true);
  const update = (await at("2026-10-14T04:01:00Z", () =>
    call("save_status_update", {
      type: "project",
      project: trackerProject.id,
      body: "Playable route milestone. ![route](https://example.invalid/route.png) [Evidence](clankie://evidence/sha256/fixture)",
    }),
  )) as { id: string };
  const extra = (await at("2026-10-14T04:02:00Z", () =>
    call("save_status_update", {
      type: "project",
      project: trackerProject.id,
      body: "Unrequested routine update",
    }),
  )) as { id: string };
  const after = await measureVelocity(
    project,
    record.lastMilestone(project.id),
    deps,
    new Date("2026-10-14T05:00:00Z"),
  );
  record.observeUpdates(after);
  record = new AutoRoundRecord(directory);
  record.observeUpdates(after); // A restart and a repeated snapshot do not append duplicates.
  const rounds = AutoRoundsResponseSchema.parse({ schemaVersion: 1, rounds: record.read() }).rounds;
  expect(rounds.find((round) => round.roundId === roundId)!.projects[0]!.report!.updates).toMatchObject([
    { id: update.id, unexpected: false },
  ]);
  expect(rounds.find((round) => round.roundId === routineId)!.projects[0]!.report!.updates).toMatchObject([
    { id: extra.id, unexpected: true },
  ]);
  expect(record.withReporting(after).report!.milestones).toEqual([]);
  expect(after.window.since).toBe(first.lastMilestone!.at);
});

it("retries a definite refusal, but never repeats a milestone request left unsettled by a restart", async () => {
  const { project, deps, at, call } = await measuredProject();
  const directory = join(roots.at(-1)!, "reporting");
  let record = new AutoRoundRecord(directory);
  const velocity = await measureVelocity(project, null, deps, new Date("2026-10-14T03:00:00Z"));
  const first = record.withReporting(velocity);
  record.settled(record.measured("lead", [first]), false, "not delivered");
  record = new AutoRoundRecord(directory);
  expect(record.withReporting(velocity).report!.milestones).toHaveLength(1);
  record.measured("lead", [record.withReporting(velocity)]); // Stopped between claim and wake settlement.
  record = new AutoRoundRecord(directory);
  expect(record.withReporting(velocity).report!.milestones).toEqual([]);
  const rebound = { ...velocity, tracker: { kind: "built-in" as const, projectId: "other-tracker" } };
  expect(record.withReporting(rebound).report!.milestones).toHaveLength(1);
  // Milestone identity, rather than its name or completion timestamp, is claimed.
  const renamed = {
    ...velocity,
    milestones: velocity.milestones.map((entry) => ({
      ...entry,
      ref: "Renamed",
      at: "2026-10-15T00:00:00Z",
    })),
  };
  expect(record.withReporting(renamed).report!.milestones).toEqual([]);
  const other = (await at("2026-10-14T04:00:00Z", () =>
    call("save_project", { name: "Rebound", addTeams: ["LOCAL"] }),
  )) as { id: string };
  const newSource = { ...project, trackerProjectId: other.id };
  const reboundVelocity = record.withReporting(
    await measureVelocity(newSource, null, deps, new Date("2026-10-14T04:01:00Z")),
  );
  const routineId = record.measured("lead", [reboundVelocity], new Date("2026-10-14T04:01:00Z"));
  record.settled(routineId, true);
  const update = (await at("2026-10-14T04:02:00Z", () =>
    call("save_status_update", { type: "project", project: other.id, body: "Routine post on new tracker" }),
  )) as { id: string };
  record.observeUpdates(await measureVelocity(newSource, null, deps, new Date("2026-10-14T05:00:00Z")));
  expect(
    record.read().find((round) => round.roundId === routineId)!.projects[0]!.report!.updates,
  ).toMatchObject([{ id: update.id, unexpected: true }]);
});

it("replays KH2 Shared world as one due post despite its 16-issue cleanup batch", async () => {
  const fixture = JSON.parse(
    await readFile(
      new URL("../../../packages/work-items/test/fixtures/outcomes/kh2-multiplayer.json", import.meta.url),
      "utf8",
    ),
  ) as {
    calls: { query: string; variables: Record<string, unknown>; data: Record<string, unknown> }[];
  };
  const outcomes = await collectLinearOutcomes({
    projectId: "b701962e-89aa-4685-a574-ebda25706d64",
    query: async (query, variables) => {
      const call = fixture.calls.find(
        (entry) => entry.query === query && JSON.stringify(entry.variables) === JSON.stringify(variables),
      );
      if (!call) throw new Error("Unrecorded KH2 query");
      return call.data;
    },
    window: { since: "2026-10-06T05:00:00.000Z", until: "2026-10-15T05:00:00.000Z" },
    history: true,
    now: () => new Date("2026-10-15T02:50:00Z"),
  });
  const root = await realpath(await mkdtemp(join(tmpdir(), "kh2-reporting-")));
  roots.push(root);
  const record = new AutoRoundRecord(root);
  const velocity = await measureVelocity(
    ProjectSchema.parse({ id: "kh2", name: "KH2", auto: true, workspaces: [] }),
    null,
    {
      outcomes: async () => ({ state: "read", outcomes }),
      history: async () => ({ state: "unknown", reason: "tracker-only replay" }),
      churn: readRepositoryChurn,
    },
    new Date("2026-10-15T05:00:00Z"),
  );
  const report = record.withReporting(velocity);
  expect(outcomes.closed.filter((issue) => issue.completedAt! >= "2026-10-14T05:00:00.000Z")).toHaveLength(
    16,
  );
  expect(report.report!.milestones).toMatchObject([
    { kind: "milestone", ref: "Shared world", at: "2026-10-15T01:44:38.451Z" },
  ]);
  record.settled(record.measured("lead", [report]), true);
  expect(new AutoRoundRecord(root).withReporting(velocity).report!.milestones).toEqual([]);
  // More than one newly complete milestone in a round still earns one combined post.
  const batch = record.withReporting({
    ...velocity,
    milestones: [
      { kind: "parent", ref: "VUH-new-parent", at: "2026-10-15T04:00:00Z" },
      { kind: "milestone", ref: "New world", id: "new-world", at: "2026-10-15T04:00:00Z" },
    ],
  });
  expect(batch.report!.milestones).toHaveLength(2);
  expect(
    reportingSection([batch])
      .join("\n")
      .match(/Post exactly one/g),
  ).toHaveLength(1);
  const state: AutoProjectState = { id: "kh2", name: "KH2", workers: 0 };
  expect(autoRoundFingerprint([state], undefined, () => milestoneSignals(report))).not.toBe(
    autoRoundFingerprint([state]),
  );
  // Claiming a post changes no milestone fingerprint, so it does not cause an extra wake.
  expect(milestoneSignals(record.withReporting(velocity))).toEqual(milestoneSignals(report));
});

it("replays completed days over real tracker history and origin through HTTP/CLI without waking or persisting rounds", async () => {
  const { project, deps, product, quiet, at, call } = await measuredProject();
  // Today it is reopened; the replay must still see yesterday's completed state.
  await at("2026-10-14T15:00:00.000Z", () =>
    call("save_issue", { id: product.id, state: "In Progress" }, owner),
  );
  const root = roots.at(-1)!;
  const { replayAutoRounds } = await import("../src/captain/auto-replay.ts");
  const { FileCredentialStore, OPERATOR_CREDENTIAL_PROVIDER_ID, mintOperatorToken } =
    await import("@clankie/credential-broker");
  const record = new AutoRoundRecord(join(root, "replay-rounds"));
  const token = mintOperatorToken();
  let wakes = 0;
  const trackerBefore = await readFile(join(root, "tracker", "tracker.json"), "utf8");
  const captain = createStubCaptain({
    wakeConversation: async () => {
      wakes++;
      return false;
    },
  });
  captain.replayAutoRounds = (query) => replayAutoRounds(project, query, deps);
  const service = await createClankieApp({
    captain,
    autoRounds: record,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${token}` ? { operatorId: "replay-owner" } : undefined,
  });
  const server = serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => service.app.fetch(request),
  }) as Server;
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing replay address");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const credentials = new FileCredentialStore(join(root, "replay-credentials.json"));
    await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
    let written = "";
    const options = {
      env: { CLANKIE_CONTROL_PLANE_URL: origin },
      operatorCredentialStore: credentials,
      stdout: { write: (chunk: string) => ((written += chunk), true) },
    };
    const query = "replay=true&project=mod&since=2026-10-11T05:00:00Z&until=2026-10-14T05:00:00Z";
    expect((await fetch(`${origin}/v1/auto/rounds?${query}`)).status).toBe(401);
    expect(
      await runConversationsCommand(
        [
          "auto",
          "rounds",
          "--replay",
          "--project",
          "mod",
          "--since",
          "2026-10-11T00:00:00-05:00",
          "--until",
          "2026-10-14T00:00:00-05:00",
        ],
        options,
      ),
    ).toBe(0);
    const replay = AutoRoundsResponseSchema.parse(JSON.parse(written));
    expect(replay.rounds).toHaveLength(3);
    const early = replay.rounds[0]!.projects[0]!;
    const middle = replay.rounds[1]!.projects[0]!;
    const later = replay.rounds[2]!.projects[0]!;
    expect(early.started).toMatchObject({ state: "known", total: 0 });
    expect(middle.started).toMatchObject({ state: "known", total: 1 });
    expect(early.closures).toMatchObject({ state: "known", ownerFacing: [], tooling: [], unlinked: [] });
    expect(middle.drift).toContainEqual(
      expect.objectContaining({ signal: "nothing_closed", day: "2026-10-12" }),
    );
    expect(later.closures).toMatchObject({
      state: "known",
      ownerFacing: [product.identifier],
      unlinked: [quiet.identifier],
    });
    expect(later.started).toMatchObject({ cap: null });
    expect(later.caveats.join(" ")).toContain("over_wip cannot be evaluated");
    expect(replay.rounds.every((round) => round.delivery === null && round.conversationId === "replay")).toBe(
      true,
    );
    expect(record.read({})).toEqual([]);
    expect(wakes).toBe(0);
    expect(await readFile(join(root, "tracker", "tracker.json"), "utf8")).toBe(trackerBefore);
    expect(
      (
        await fetch(`${origin}/v1/auto/rounds?${query}&limit=1`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(400);
    for (const invalid of [
      "since=2026-10-14T05:00:00Z&until=2026-10-12T05:00:00Z",
      "since=2026-09-01T05:00:00Z&until=2026-10-14T05:00:00Z",
      "since=2099-01-01T00:00:00Z&until=2099-01-02T00:00:00Z",
    ]) {
      expect(
        (
          await fetch(`${origin}/v1/auto/rounds?replay=true&project=mod&${invalid}`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
      ).toBe(400);
    }
    await expect(
      runConversationsCommand(["auto", "rounds", "--replay", "--project", "mod"], options),
    ).rejects.toThrow("Usage: clankie auto");
  } finally {
    service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("retains a drift response across restart and keeps unreadable correction checks unknown", async () => {
  const { project, deps, call } = await measuredProject();
  const directory = join(roots.at(-1)!, "auto-rounds");
  let record = new AutoRoundRecord(directory);
  const at = new Date("2026-10-14T03:00:00.000Z");
  const velocity = withDrift(await measureVelocity(project, null, deps, at), []);
  const roundId = record.measured("lead", [velocity], at);
  record.settled(roundId, true, undefined, at);
  const issue = (await call("save_issue", {
    team: "LOCAL",
    project: project.trackerProjectId,
    title: "Next playable feature",
  })) as { identifier: string };
  const input = {
    projectId: project.id,
    roundId,
    issue: issue.identifier,
    reason: "Ship the next milestone feature",
  };
  expect(() => record.recordCorrection("other-lead", input, at)).toThrow("owned by this conversation");
  const correction = record.recordCorrection("lead", input, at);
  record = new AutoRoundRecord(directory);
  expect(record.pendingCorrection(project.id)).toEqual(correction);
  expect(record.recordCorrection("lead", input, at)).toEqual(correction);
  expect(record.read()[0]!.projects[0]).toMatchObject({ drift: velocity.drift, correction });
  const unknown = await measureVelocity(
    project,
    null,
    {
      ...deps,
      correction,
      outcomes: async () => ({ state: "unavailable" as const, reason: "tracker offline" }),
      history: async () => ({ state: "unknown" as const, reason: "origin unreadable" }),
    },
    new Date("2026-10-14T04:00:00Z"),
  );
  expect(unknown.correctionCheck).toMatchObject({ state: "unknown", issueStarted: null, productLines: null });
  expect(driftSection([unknown]).join("\n")).toContain("tracker offline");
  record.measured("lead", [unknown], new Date("2026-10-14T04:00:00Z"));
  expect(new AutoRoundRecord(directory).pendingCorrection(project.id)).toEqual(correction);
});
