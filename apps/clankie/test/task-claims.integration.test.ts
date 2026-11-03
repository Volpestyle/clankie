/**
 * #602: a deliverable has one live hire per project. An accidental second claim is
 * refused naming its holder; deliberate attempts race different harnesses or models
 * in their own worktrees, and the one that lands supersedes the rest.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import type { SpawnOperatorSeat } from "@clankie/protocol";
import { landedSince, ProjectHires } from "../src/captain/project-hires.ts";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const scratch = async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-task-claims-"));
  roots.push(root);
  return root;
};
const settings = () =>
  ProjectsSettingsSchema.parse({
    projects: [
      {
        id: "game",
        name: "Game",
        workerCap: 10,
        roles: [{ role: "Engineer", harness: "claude", concurrencyCap: 10 }],
      },
    ],
  });
const hire = (workingDirectory: string, extra: Partial<SpawnOperatorSeat> = {}): SpawnOperatorSeat => ({
  schemaVersion: 1,
  harness: "claude",
  title: "Worker",
  workingDirectory,
  deliverable: "Volpestyle/clankie#602",
  ...extra,
});
/** A hire as a launched, observed pane: what the ledger holds while the worker runs. */
const running = (ledger: ProjectHires, id: string, pane: string) => {
  ledger.launch(id, settings());
  ledger.pane(id, pane);
  ledger.confirmed(id);
};

it("two controllers racing to claim one deliverable leave exactly one claim", async () => {
  const root = await scratch();
  const path = join(root, "project-hires.json");
  const settingsPath = join(root, "projects.json");
  await writeFile(settingsPath, JSON.stringify(settings()));
  const fixture = join(import.meta.dirname, "fixtures/claim-racer.ts");
  // Separate processes, separate worktrees, one deliverable, one start instant.
  const startAt = Date.now() + 1_500;
  const results = await Promise.all(
    [0, 1, 2, 3].map(async (n) => {
      const { stdout } = await exec(
        process.execPath,
        ["--import", "tsx", fixture, path, settingsPath, join(root, `wt-${n}`), "Volpestyle/clankie#602", `${startAt}`],
        // tsx resolves from the service package, as the service's own children do.
        { timeout: 30_000, cwd: join(import.meta.dirname, "..") },
      );
      return JSON.parse(stdout) as { claimed?: string; refused?: string };
    }),
  );
  const claimed = results.filter((result) => result.claimed !== undefined);
  expect(claimed).toHaveLength(1);
  // Every other racer was refused because the claim existed, not because the ledger was busy.
  for (const result of results.filter((entry) => entry.refused !== undefined))
    expect(result.refused).toMatch(/^Deliverable Volpestyle\/clankie#602 is already claimed by claude/u);
  const state = JSON.parse(await readFile(path, "utf8"));
  expect(state.allocations.map((allocation: { id: string }) => allocation.id)).toEqual([claimed[0]!.claimed]);
});

it("refuses a second claim naming its holder, and frees the claim when the holder's pane is gone", async () => {
  const root = await scratch();
  const ledger = new ProjectHires(join(root, "project-hires.json"));
  const first = ledger.reserve(settings(), "game", hire(join(root, "a")));
  running(ledger, first.id, "w1:p1");
  ledger.observe(first.id, "seat-1", "occupant-1");
  const second = () => ledger.reserve(settings(), "game", hire(join(root, "b"), { harness: "codex" }));
  expect(second).toThrow(
    /^Deliverable Volpestyle\/clankie#602 is already claimed by claude \(seat seat-1\), allocation .+ in pane w1:p1 \(age \d+s\)\. .*close_worker_pane.*attempt: true/u,
  );
  // An attempt can't join an ordinary claim either: the holder didn't agree to a race.
  expect(() =>
    ledger.reserve(settings(), "game", hire(join(root, "b"), { harness: "codex", attempt: true })),
  ).toThrow("already claimed");
  // Another deliverable is free.
  expect(
    ledger.reserve(settings(), "game", hire(join(root, "c"), { deliverable: "Volpestyle/clankie#603" })).reused,
  ).toBe(false);
  // The holder crashed and its pane is gone: a complete census releases the claim.
  ledger.reconcile("default", new Set(), new Set(), ledger.inventoryCandidates("default"));
  expect(second().reused).toBe(false);
});

it("lets deliberate attempts race different harnesses in their own worktrees, and the landed one supersedes the rest", async () => {
  const root = await scratch();
  const ledger = new ProjectHires(join(root, "project-hires.json"));
  const claude = ledger.reserve(settings(), "game", hire(join(root, "claude"), { attempt: true }));
  running(ledger, claude.id, "w1:p1");
  const codex = ledger.reserve(
    settings(),
    "game",
    hire(join(root, "codex"), { harness: "codex", model: "sol 6.1", attempt: true }),
  );
  running(ledger, codex.id, "w1:p2");
  // The same harness and model twice is an accident, not a race.
  expect(() => ledger.reserve(settings(), "game", hire(join(root, "again"), { attempt: true }))).toThrow(
    "same harness and model",
  );
  // Attempts never share files.
  expect(() =>
    ledger.reserve(settings(), "game", hire(join(root, "claude"), { model: "Opus", attempt: true })),
  ).toThrow(/Give each attempt its own worktree|Blocking hire/u);
  // An ordinary hire can't slip in beside the attempts.
  expect(() => ledger.reserve(settings(), "game", hire(join(root, "plain"), { harness: "pi" }))).toThrow(
    "already claimed by an attempt by claude",
  );
  expect(ledger.attempt("default", "w1:p1")).toEqual({ deliverable: "Volpestyle/clankie#602", superseded: false });
  expect(ledger.attempt("default", "w9:p9")).toBeUndefined();

  // Codex's work lands first: it wins, Claude's attempt is superseded, and a second
  // settlement changes nothing.
  expect(ledger.settleAttempt("default", "w1:p2")).toEqual(["w1:p1"]);
  expect(ledger.settleAttempt("default", "w1:p1")).toEqual([]);
  expect(ledger.attempt("default", "w1:p1")).toEqual({ deliverable: "Volpestyle/clankie#602", superseded: true });
  expect(ledger.allocation(codex.id)).toMatchObject({
    attemptWon: expect.any(String),
    request: { harness: "codex", model: "sol 6.1" },
  });
  expect(ledger.allocation(claude.id)).toMatchObject({ supersededBy: codex.id });
});

it("an attempt has landed only once it made commits since its hire and all of them are on main", async () => {
  const root = await scratch();
  const git = (cwd: string, ...args: string[]) =>
    exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd });
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  await exec("git", ["init", "-q", "--bare", "-b", "main", origin]);
  await exec("git", ["clone", "-q", origin, work]);
  await git(work, "commit", "-q", "--allow-empty", "-m", "base");
  await git(work, "push", "-q", "origin", "HEAD:main");
  await git(work, "fetch", "-q", "origin");
  const start = (await git(work, "rev-parse", "HEAD")).stdout.trim();
  // Nothing made yet.
  expect(await landedSince(work, start)).toBe(false);
  await writeFile(join(work, "fix.txt"), "fix\n");
  // Uncommitted work hasn't landed.
  expect(await landedSince(work, start)).toBe(false);
  await git(work, "add", "fix.txt");
  await git(work, "commit", "-q", "-m", "fix");
  // Committed but not on main.
  expect(await landedSince(work, start)).toBe(false);
  await git(work, "push", "-q", "origin", "HEAD:main");
  await git(work, "fetch", "-q", "origin");
  expect(await landedSince(work, start)).toBe(true);
});
