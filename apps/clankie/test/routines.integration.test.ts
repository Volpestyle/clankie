import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { OperatorSeatSpawnResult, RoutineCommand, RoutinesStatus } from "@clankie/protocol";
import { runRoutinesCommand } from "../../tui/src/command/routines.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createRoutineRunner } from "../src/captain/routine-runner.ts";
import { RoutineStore, type RoutineActor } from "../src/captain/routines.ts";

// VUH-2018 / ADR 0265: routines survive restarts with no double runs, and a
// Mac that slept through runs follows the routine's missed-run policy. Real
// state files, real cron in a real time zone, the real runner, HTTP route and
// CLI. The conversation turn and the hire are the recorded boundary; a check
// runs a real child process through a stand-in for `clankie heavy`.

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

const MAIN = "global-main";
const OWNER: RoutineActor = { kind: "owner" };

function fixture(start: string) {
  const root = mkdtempSync(join(tmpdir(), "routines-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const clock = { now: Date.parse(start) };
  const turns: Array<{ conversationId: string; prompt: string; finish: () => void }> = [];
  const hires: Array<{ conversationId: string; title: string; brief: string }> = [];
  const notes: Array<{ conversationId: string; text: string }> = [];
  // `clankie heavy --seat S --holder H -- CMD...` stand-in: run CMD as given.
  const heavy = join(root, "heavy.mjs");
  writeFileSync(
    heavy,
    'import { spawnSync } from "node:child_process";\n' +
      'const argv = process.argv.slice(process.argv.indexOf("--") + 1);\n' +
      'const result = spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });\n' +
      "process.exit(result.status ?? 1);\n",
  );
  const execute = createRoutineRunner({
    runTurn: (conversationId, prompt) =>
      new Promise<void>((resolve) => turns.push({ conversationId, prompt, finish: resolve })),
    hire: async (conversationId, seat, brief): Promise<OperatorSeatSpawnResult> => {
      hires.push({ conversationId, title: seat.title, brief });
      return {
        outcome: "spawned",
        seat: { seatId: `w9:p${String(hires.length)}` },
      } as OperatorSeatSpawnResult;
    },
    notify: async (conversationId, text) => {
      notes.push({ conversationId, text });
      return true;
    },
    launcher: { command: process.execPath, args: [heavy] },
  });
  const open = () => {
    const store = new RoutineStore({
      stateDir: root,
      execute,
      validateTarget: (target) => {
        if (!["global-main", "lead-kh2"].includes(target.conversationId)) throw new Error("no such chat");
      },
      defaultConversationId: () => MAIN,
      now: () => clock.now,
      tickMs: 3_600_000,
    });
    cleanup.push(() => store.close());
    return store;
  };
  const at = (iso: string) => {
    clock.now = Date.parse(iso);
  };
  return { root, clock, at, open, turns, hires, notes };
}

const daily = (store: RoutineStore, missed?: "catch_up" | "skip") =>
  store.command(
    {
      action: "add",
      name: "Morning triage",
      schedule: { when: "every day at 9:00", timeZone: "America/Chicago" },
      target: { kind: "turn", prompt: "Triage new KH2 issues." },
      ...(missed === undefined ? {} : { missed }),
    },
    OWNER,
  );

const history = async (store: RoutineStore) =>
  (await store.command({ action: "history", limit: 50 }, OWNER)).runs ?? [];

it("a restart mid-run never runs that slot again, and the schedule carries on", async () => {
  const f = fixture("2026-10-12T13:00:00.000Z"); // 08:00 in Chicago
  const first = f.open();
  const added = await daily(first);
  expect(added.routine).toMatchObject({
    schedule: { cron: "0 9 * * *", timeZone: "America/Chicago", text: "every day at 9:00" },
    target: { kind: "turn", conversationId: MAIN },
    nextRunAt: "2026-10-12T14:00:00.000Z",
  });
  first.start();

  f.at("2026-10-12T14:00:20.000Z");
  await first.tick();
  expect(f.turns).toHaveLength(1);
  expect(f.turns[0]!.prompt).toContain(
    'Routine "Morning triage" (every day at 9:00, America/Chicago), schedule run',
  );
  expect(f.turns[0]!.prompt).toContain("Triage new KH2 issues.");

  // The service restarts while that turn is still going.
  first.close();
  const second = f.open();
  second.start();
  f.at("2026-10-12T14:00:50.000Z");
  await second.tick();
  await second.tick();
  expect(f.turns).toHaveLength(1);
  expect((await history(second)).map((run) => run.status)).toEqual(["interrupted"]);

  // A deploy can briefly run two services on one state directory: one claim, one run.
  f.at("2026-10-13T14:00:05.000Z");
  const overlapping = f.open();
  await Promise.all([second.tick(), overlapping.tick()]);
  expect(f.turns).toHaveLength(2);
  f.turns[1]!.finish();
  await second.settled();
  await overlapping.settled();
  const runs = await history(f.open());
  expect(runs.map((run) => [run.slot, run.status])).toEqual([
    ["2026-10-13T14:00:00.000Z", "succeeded"],
    ["2026-10-12T14:00:00.000Z", "interrupted"],
  ]);
  expect(runs[0]!.durationMs).toBeGreaterThanOrEqual(0);
});

it("a Mac asleep through runs catches up once, or skips, per the routine's policy", async () => {
  const f = fixture("2026-10-12T13:00:00.000Z");
  const store = f.open();
  const catchUp = (await daily(store)).routine!;
  const skip = (
    await store.command(
      {
        action: "add",
        name: "Weekday standup",
        schedule: { when: "every weekday at 9:30", timeZone: "America/Chicago" },
        target: { kind: "turn", conversationId: "lead-kh2", prompt: "Post the standup." },
        missed: "skip",
      },
      OWNER,
    )
  ).routine!;
  store.start();

  // Asleep from Monday 08:00 to Wednesday 12:00 Chicago: three 9:00s and three weekday 9:30s.
  f.at("2026-10-14T17:00:00.000Z");
  await store.tick();
  expect(f.turns.map((turn) => turn.conversationId)).toEqual([MAIN]);
  expect(f.turns[0]!.prompt).toContain("catch_up run for 2026-10-14T14:00:00.000Z");
  expect(f.turns[0]!.prompt).toContain("stands in for 3 runs missed");
  f.turns[0]!.finish();
  await store.settled();
  const runs = await history(store);
  expect(runs.find((run) => run.routineId === catchUp.id)).toMatchObject({
    trigger: "catch_up",
    status: "succeeded",
    missed: 3,
  });
  expect(runs.find((run) => run.routineId === skip.id)).toMatchObject({
    status: "skipped",
    missed: 3,
    slot: "2026-10-14T14:30:00.000Z",
  });

  // Nothing is owed twice; Thursday's runs go out (9:00 is half an hour behind, 9:30 is due).
  await store.tick();
  expect(f.turns).toHaveLength(1);
  f.at("2026-10-15T14:30:30.000Z");
  await store.tick();
  expect(f.turns.map((turn) => turn.conversationId)).toEqual([MAIN, MAIN, "lead-kh2"]);
});

it("hires and checks run as their conversation, and leads only reach their own routines", async () => {
  const f = fixture("2026-10-16T20:00:00.000Z");
  const store = f.open();
  const lead: RoutineActor = { kind: "lead", conversationId: "lead-kh2" };
  await expect(
    store.command(
      {
        action: "add",
        name: "Someone else's",
        schedule: { when: "every friday at 10:00" },
        target: { kind: "turn", conversationId: MAIN, prompt: "x" },
      },
      lead,
    ),
  ).rejects.toThrow("must target its own conversation");
  const hire = (
    await store.command(
      {
        action: "add",
        name: "Cleanup audit",
        schedule: { when: "every friday at 17:30", timeZone: "UTC" },
        target: {
          kind: "hire",
          hire: { title: "Ada", role: "builder", workingDirectory: f.root },
          brief: "Run the codebase-cleanup audit.",
        },
      },
      lead,
    )
  ).routine!;
  expect(hire.target.conversationId).toBe("lead-kh2");
  const check = (
    await store.command(
      {
        action: "add",
        name: "Typecheck",
        schedule: { when: "0 * * * *", timeZone: "UTC" },
        target: {
          kind: "check",
          command: [process.execPath, "-e", "console.log('nope'); process.exit(3)"],
          workingDirectory: f.root,
        },
      },
      OWNER,
    )
  ).routine!;
  expect((await store.command({ action: "list" }, lead)).routines.map((routine) => routine.id)).toEqual([
    hire.id,
  ]);
  await expect(store.command({ action: "pause", id: check.id }, lead)).rejects.toThrow("No routine");

  await store.command({ action: "run_now", id: hire.id }, lead);
  await store.command({ action: "run_now", id: check.id }, OWNER);
  await store.settled();
  expect(f.hires).toEqual([
    {
      conversationId: "lead-kh2",
      title: "Ada",
      brief: expect.stringContaining("Run the codebase-cleanup audit."),
    },
  ]);
  const runs = await history(store);
  expect(runs.find((run) => run.routineId === hire.id)).toMatchObject({
    trigger: "manual",
    status: "succeeded",
    detail: "Hired Ada as w9:p1.",
  });
  expect(runs.find((run) => run.routineId === check.id)).toMatchObject({
    status: "failed",
    detail: expect.stringMatching(/^exited 3 after [\d.]+s\.\n\nnope$/u),
  });
  expect(f.notes.map((note) => note.conversationId)).toEqual(["lead-kh2", MAIN]);
  expect(f.notes[1]!.text).toContain("exited 3");
});

it("the CLI manages routines through the authenticated API", async () => {
  const f = fixture("2026-10-12T12:00:00.000Z");
  const store = f.open();
  const { app } = await createClankieApp({
    captain: createStubCaptain({ routineCommand: (command) => store.command(command, OWNER) }),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner-token" ? { operatorId: "owner" } : undefined,
  });
  const cli = (args: string[]) =>
    runRoutinesCommand(args, {
      env: { CLANKIE_OPERATOR_TOKEN: "owner-token" },
      host: "http://clankie.test",
      fetchImpl: ((url: string, init?: RequestInit) => app.request(url, init)) as typeof fetch,
    });
  const ok = async (args: string[]): Promise<RoutinesStatus> => {
    const result = await cli(args);
    if (!result.ok) throw new Error(result.error);
    return result.status;
  };

  const added = await ok([
    "add",
    "Morning triage",
    "--when",
    "every weekday at 9:00",
    "--tz",
    "America/Chicago",
    "--turn",
    "Triage.",
  ]);
  const id = added.routine!.id;
  expect(added.routine).toMatchObject({
    schedule: { cron: "0 9 * * 1-5" },
    enabled: true,
    missed: "catch_up",
  });
  expect((await ok(["pause", id])).routine).toMatchObject({ enabled: false });
  expect((await ok(["edit", id, "--when", "every monday at 8am", "--missed", "skip"])).routine).toMatchObject(
    {
      schedule: { cron: "0 8 * * 1", timeZone: "America/Chicago" },
      missed: "skip",
    },
  );
  expect((await ok(["resume", id])).routine).toMatchObject({
    enabled: true,
    nextRunAt: "2026-10-12T13:00:00.000Z",
  });
  await ok(["run-now", id]);
  expect((await ok(["history", id])).runs).toMatchObject([{ trigger: "manual", status: "running" }]);
  f.turns[0]!.finish();
  await store.settled();
  expect((await ok(["history"])).runs).toMatchObject([{ status: "succeeded" }]);

  const refused = await cli(["add", "Bad", "--when", "whenever you like", "--turn", "x"]);
  expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("Schedule not understood") });
  const unauthenticated = await app.request("http://clankie.test/v1/captain/routines");
  expect(unauthenticated.status).toBe(401);

  expect((await ok(["remove", id])).routines).toEqual([]);
  const command: RoutineCommand = { action: "list" };
  expect((await store.command(command, OWNER)).routines).toEqual([]);
});
