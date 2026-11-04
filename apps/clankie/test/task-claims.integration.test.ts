/**
 * #602: a deliverable has one live hire per project. An accidental second claim is
 * refused naming its holder; deliberate attempts race different harnesses or models
 * in their own worktrees, and the one that lands supersedes the rest.
 */
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import type { SpawnOperatorSeat } from "@clankie/protocol";
import { attemptLaunch, ProjectHires, settleAttemptByMerge } from "../src/captain/project-hires.ts";
import { SeatEfficiencyStore } from "../src/captain/seat-efficiency.ts";
import { readSeatCommitBaseline } from "../src/captain/seat-telemetry.ts";
import { hireWorktreeLaunch, verifyRemoteHireCheckout } from "../src/captain/checkout-freshness.ts";
import type { HerdrFleet } from "../src/herdr-fleet.ts";
import { createWorkItemsService } from "../src/work-items.ts";

const exec = promisify(execFile);
const roots: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
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
  ledger.observe(id, `seat-${pane}`, `occupant-${pane}`);
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
        [
          "--import",
          "tsx",
          fixture,
          path,
          settingsPath,
          join(root, `wt-${n}`),
          "Volpestyle/clankie#602",
          `${startAt}`,
        ],
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
  const second = () => ledger.reserve(settings(), "game", hire(join(root, "b"), { harness: "codex" }));
  expect(second).toThrow(
    /^Deliverable Volpestyle\/clankie#602 is already claimed by claude \(seat seat-w1:p1\), allocation .+ in pane w1:p1 \(age \d+s\)\. .*close_worker_pane.*attempt: true/u,
  );
  // An attempt can't join an ordinary claim either: the holder didn't agree to a race.
  expect(() =>
    ledger.reserve(settings(), "game", hire(join(root, "b"), { harness: "codex", attempt: true })),
  ).toThrow("already claimed");
  // Another deliverable is free.
  expect(
    ledger.reserve(settings(), "game", hire(join(root, "c"), { deliverable: "Volpestyle/clankie#603" }))
      .reused,
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
  expect(ledger.attempt("default", "w1:p1")).toMatchObject({
    allocation: claude.id,
    occupantId: "occupant-w1:p1",
    deliverable: "Volpestyle/clankie#602",
    superseded: false,
  });
  expect(ledger.attempt("default", "w9:p9")).toBeUndefined();

  // A record whose occupant no longer matches settles nothing.
  const replaced = { allocation: codex.id, occupantId: "occupant-replaced" };
  expect(ledger.attemptCandidates(replaced.allocation, replaced.occupantId)).toBeUndefined();
  // Codex's work lands first and its close released its allocation: the retained record
  // still wins, Claude's attempt is superseded, and a second settlement changes nothing.
  ledger.reconcile("default", new Set(["w1:p1"]), new Set(), ledger.inventoryCandidates("default"));
  expect(ledger.allocation(codex.id)?.gone).toBe(true);
  const record = { allocation: codex.id, occupantId: "occupant-w1:p2" };
  const { revision } = ledger.attemptCandidates(record.allocation, record.occupantId)!;
  expect(ledger.settleAttempt(replaced, revision, codex.id)).toBeUndefined();
  expect(ledger.settleAttempt(record, revision, codex.id)).toEqual(["w1:p1"]);
  expect(ledger.settleAttempt(record, revision, codex.id)).toBeUndefined();
  expect(ledger.attemptCandidates(record.allocation, record.occupantId)).toBeUndefined();
  expect(ledger.attempt("default", "w1:p1")).toMatchObject({ superseded: true });
  expect(ledger.allocation(codex.id)).toMatchObject({
    attemptWon: expect.any(String),
    request: { harness: "codex", model: "sol 6.1" },
  });
  expect(ledger.allocation(claude.id)).toMatchObject({ supersededBy: codex.id });
});

/**
 * GitHub as the host reads it, over a real bare origin: the default branch, the pull
 * requests merged from each branch, and GitHub's comparison of two commits, answered by
 * Git's own ancestry. Only the pull requests a test records here count as merges.
 */
type FixturePull = { number: number; mergedAt: string; head: string };
const githubFixture = async (origin: string) => {
  const merged = new Map<string, FixturePull[]>();
  const server = createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fixture");
      if (url.pathname === "/repos/Volpestyle/clankie") return send(200, { default_branch: "main" });
      if (url.pathname === "/repos/Volpestyle/clankie/pulls") {
        const branch = url.searchParams.get("head")?.replace(/^Volpestyle:/u, "") ?? "";
        return send(
          200,
          (merged.get(branch) ?? []).map((pull) => ({
            number: pull.number,
            html_url: `https://github.com/Volpestyle/clankie/pull/${pull.number}`,
            merged_at: pull.mergedAt,
            head: { ref: branch, sha: pull.head, repo: { full_name: "Volpestyle/clankie" } },
            base: { ref: "main" },
          })),
        );
      }
      const compare = /^\/repos\/Volpestyle\/clankie\/compare\/([a-f0-9]+)\.\.\.([a-f0-9]+)$/u.exec(
        url.pathname,
      );
      if (compare) {
        if (compare[1] === compare[2]) return send(200, { status: "identical" });
        const ahead = await exec("git", ["merge-base", "--is-ancestor", compare[1]!, compare[2]!], {
          cwd: origin,
        }).then(
          () => true,
          () => false,
        );
        return send(200, { status: ahead ? "ahead" : "diverged" });
      }
      send(404, { message: "Not Found" });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${port}`, merged };
};
/** A real origin whose main has moved on, and checkouts of it as attempts start them. */
const repository = async (root: string) => {
  const git = (cwd: string, ...args: string[]) =>
    exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
      cwd,
    });
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  await exec("git", ["init", "-q", "--bare", "-b", "main", origin]);
  await exec("git", ["clone", "-q", origin, seed]);
  await git(seed, "commit", "-q", "--allow-empty", "-m", "base");
  await git(seed, "push", "-q", "origin", "HEAD:main");
  // Hires work in linked worktrees of the shared checkout, on a new branch from origin's main.
  const checkout = async (name: string, branch: string) => {
    const dir = join(root, name);
    await git(seed, "fetch", "-q", "origin");
    await git(seed, "worktree", "add", "-q", "-b", branch, dir, "origin/main");
    return dir;
  };
  return { git, origin, seed, checkout };
};
const owner = { conversationId: "lead" };
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

it("an attempt wins only by a pull request GitHub merged from its hire branch after the hire, never by what its worktree writes", async () => {
  const root = await scratch();
  const repo = await repository(root);
  const { git } = repo;
  // An old pull request from a branch named like B's merged long before these hires,
  // made in another checkout; main has moved on since.
  const earlier = join(root, "earlier");
  await exec("git", ["clone", "-q", repo.origin, earlier]);
  await git(earlier, "commit", "-q", "--allow-empty", "-m", "old work");
  const old = (await git(earlier, "rev-parse", "HEAD")).stdout.trim();
  await git(earlier, "push", "-q", "origin", "HEAD:clankie/attempt-b");
  await git(repo.seed, "commit", "-q", "--allow-empty", "-m", "main moves on");
  await git(repo.seed, "push", "-q", "origin", "HEAD:main");
  // Two attempts start from the same main, each on the branch its hire records before launch.
  const a = await repo.checkout("attempt-a", "clankie/attempt-a");
  const b = await repo.checkout("attempt-b", "clankie/attempt-b");
  const efficiency = new SeatEfficiencyStore(join(root, "seat-efficiency.json"));
  efficiency.assign("occupant-w1:p1", { owner, commitBaseline: (await readSeatCommitBaseline(a))! });
  efficiency.assign("occupant-w1:p2", { owner, commitBaseline: (await readSeatCommitBaseline(b))! });
  const ledger = new ProjectHires(join(root, "project-hires.json"));
  const claude = ledger.reserve(settings(), "game", hire(a, { attempt: true }));
  running(ledger, claude.id, "w1:p1");
  const codex = ledger.reserve(settings(), "game", hire(b, { harness: "codex", attempt: true }));
  running(ledger, codex.id, "w1:p2");
  const github = await githubFixture(repo.origin);
  github.merged.set("clankie/attempt-b", [{ number: 5, mergedAt: minutesFromNow(-24 * 60), head: old }]);
  const service = createWorkItemsService({
    stateDirectory: root,
    githubToken: async () => "fixture-only",
    githubApiBase: github.baseUrl,
  });
  const settle = (record: { allocation: string; occupantId: string }) =>
    settleAttemptByMerge(
      ledger,
      record,
      (candidate) => attemptLaunch(efficiency.readLaunchBaseline(candidate.occupantId ?? "", owner)),
      (repository, launch) => service.mergedPull(repository, launch),
    );
  const closingB = { allocation: codex.id, occupantId: "occupant-w1:p2" };
  const unsettled = () => {
    for (const id of [claude.id, codex.id]) {
      expect(ledger.allocation(id)?.attemptWon).toBeUndefined();
      expect(ledger.allocation(id)?.supersededBy).toBeUndefined();
    }
  };

  // A lands its fix on main directly; GitHub records no merged pull request for it.
  await writeFile(join(a, "fix.txt"), "fix\n");
  await git(a, "add", "fix.txt");
  await git(a, "commit", "-q", "-m", "fix");
  await git(a, "push", "-q", "origin", "HEAD:main");
  const landed = (await git(a, "rev-parse", "HEAD")).stdout.trim();
  // B forges its reflog: a reset onto A's landed fix, labelled as its own commit.
  await git(b, "fetch", "-q", "origin");
  await exec("git", ["reset", "-q", "--hard", "origin/main"], {
    cwd: b,
    env: { ...process.env, GIT_REFLOG_ACTION: "commit" },
  });
  expect((await git(b, "reflog", "-1", "--format=%gs")).stdout).toMatch(/^commit:/u);
  expect((await git(b, "rev-parse", "HEAD")).stdout.trim()).toBe(landed);
  const forged = await settle(closingB);
  expect(forged).toMatchObject({ outcome: "unsettled" });
  expect(forged?.detail).toContain("has no pull request merged from its hire branch since its hire");
  expect(forged?.detail).toContain("pane w1:p1, branch clankie/attempt-a");
  expect(forged?.detail).toContain("pane w1:p2, branch clankie/attempt-b");
  unsettled();

  // B copies A's fix with a cherry-pick onto its own branch and pushes it: still nothing.
  await git(b, "reset", "-q", "--hard", "origin/main~1");
  await git(b, "cherry-pick", landed);
  await git(b, "push", "-q", "--force", "origin", "HEAD:clankie/attempt-b");
  const copy = (await git(b, "rev-parse", "HEAD")).stdout.trim();
  expect(await settle(closingB)).toMatchObject({ outcome: "unsettled" });
  unsettled();

  // A's hire branch merges as a pull request. B has only the old pull request on the reused
  // branch name, merged before its hire from a head that lacks its start: one merged
  // attempt beside one without a merge settles nothing.
  await git(a, "push", "-q", "origin", "HEAD:clankie/attempt-a");
  github.merged.set("clankie/attempt-a", [{ number: 11, mergedAt: minutesFromNow(1), head: landed }]);
  const half = await settle(closingB);
  expect(half?.detail).toContain(
    "codex (pane w1:p2, branch clankie/attempt-b) has no pull request merged from its hire branch since its hire",
  );
  unsettled();

  // B then merges its copied cherry-pick as its own pull request: both merged, A first, so
  // A wins even though B's pane is the one closing.
  github.merged.set("clankie/attempt-b", [
    { number: 5, mergedAt: minutesFromNow(-24 * 60), head: old },
    { number: 12, mergedAt: minutesFromNow(2), head: copy },
  ]);
  const settled = await settle(closingB);
  expect(settled).toMatchObject({ outcome: "won", allocation: claude.id, superseded: ["w1:p2"] });
  expect(settled?.detail).toContain("https://github.com/Volpestyle/clankie/pull/11");
  expect(ledger.allocation(claude.id)?.attemptWon).toEqual(expect.any(String));
  expect(ledger.allocation(codex.id)).toMatchObject({ supersededBy: claude.id });
  expect(ledger.allocation(codex.id)?.attemptWon).toBeUndefined();
  // Settled once: a later close changes nothing.
  expect(await settle({ allocation: claude.id, occupantId: "occupant-w1:p1" })).toBeUndefined();
});

it("a hire branch first seen after launch is no evidence", async () => {
  const root = await scratch();
  const repo = await repository(root);
  const a = await repo.checkout("attempt-a", "clankie/attempt-a");
  const b = await repo.checkout("attempt-b", "clankie/attempt-b");
  const efficiency = new SeatEfficiencyStore(join(root, "seat-efficiency.json"));
  efficiency.assign("occupant-w1:p1", { owner, commitBaseline: (await readSeatCommitBaseline(a))! });
  // B's baseline came only from its first projection after launch.
  efficiency.assign("occupant-w1:p2", { owner });
  efficiency.setCommitBaseline("occupant-w1:p2", owner, (await readSeatCommitBaseline(b))!);
  expect(efficiency.readCommitBaseline("occupant-w1:p2", owner)).toBeDefined();
  expect(efficiency.readLaunchBaseline("occupant-w1:p2", owner)).toBeUndefined();
  const ledger = new ProjectHires(join(root, "project-hires.json"));
  const claude = ledger.reserve(settings(), "game", hire(a, { attempt: true }));
  running(ledger, claude.id, "w1:p1");
  const codex = ledger.reserve(settings(), "game", hire(b, { harness: "codex", attempt: true }));
  running(ledger, codex.id, "w1:p2");
  const settled = await settleAttemptByMerge(
    ledger,
    { allocation: claude.id, occupantId: "occupant-w1:p1" },
    (candidate) => attemptLaunch(efficiency.readLaunchBaseline(candidate.occupantId ?? "", owner)),
    async () => {
      throw new Error("GitHub must not be read");
    },
  );
  expect(settled?.detail).toContain("no launch record holds the hire branch of codex (pane w1:p2)");
  expect(ledger.allocation(claude.id)?.attemptWon).toBeUndefined();
});

it("an attempt that joins while GitHub is read leaves the deliverable unsettled", async () => {
  const root = await scratch();
  const ledger = new ProjectHires(join(root, "project-hires.json"));
  const claude = ledger.reserve(settings(), "game", hire(join(root, "a"), { attempt: true }));
  running(ledger, claude.id, "w1:p1");
  const codex = ledger.reserve(
    settings(),
    "game",
    hire(join(root, "b"), { harness: "codex", attempt: true }),
  );
  running(ledger, codex.id, "w1:p2");
  const launchOf = (candidate: { allocation: string }) => ({
    branch: `clankie/${candidate.allocation}`,
    startHead: "0".repeat(40),
    hiredAt: minutesFromNow(-5),
  });
  let joined: string | undefined;
  const settled = await settleAttemptByMerge(
    ledger,
    { allocation: codex.id, occupantId: "occupant-w1:p2" },
    launchOf,
    async (_repository, launch) => {
      // Attempt C is hired while the first answer is in flight.
      if (joined === undefined) {
        joined = ledger.reserve(
          settings(),
          "game",
          hire(join(root, "c"), { model: "Opus", attempt: true }),
        ).id;
        running(ledger, joined, "w1:p3");
      }
      return {
        number: launch.branch.endsWith(claude.id) ? 1 : 2,
        url: "https://github.com/Volpestyle/clankie/pull/1",
        mergedAt: launch.branch.endsWith(claude.id) ? minutesFromNow(1) : minutesFromNow(2),
      };
    },
  );
  expect(settled?.detail).toContain("the attempts changed while GitHub was read");
  for (const id of [claude.id, codex.id, joined!]) {
    expect(ledger.allocation(id)?.attemptWon).toBeUndefined();
    expect(ledger.allocation(id)?.supersededBy).toBeUndefined();
  }
});

it("leaves an attempt unsettled when its deliverable names no GitHub issue", async () => {
  const root = await scratch();
  const ledger = new ProjectHires(join(root, "project-hires.json"));
  const one = ledger.reserve(
    settings(),
    "game",
    hire(join(root, "one"), { deliverable: "VUH-602", attempt: true }),
  );
  running(ledger, one.id, "w1:p1");
  const settled = await settleAttemptByMerge(
    ledger,
    { allocation: one.id, occupantId: "occupant-w1:p1" },
    () => ({ branch: "b", startHead: "0".repeat(40), hiredAt: minutesFromNow(-5) }),
    async () => {
      throw new Error("GitHub must not be read");
    },
  );
  expect(settled?.detail).toContain("the deliverable names no GitHub issue");
  expect(ledger.allocation(one.id)?.attemptWon).toBeUndefined();
});

it("a remote attempt records its launch from the worktree its machine made, and its merge supersedes a local sibling (#703)", async () => {
  const root = await scratch();
  const repo = await repository(root);
  const { git } = repo;
  // The local attempt starts as local hires do, from a baseline captured before launch.
  const local = await repo.checkout("attempt-local", "clankie/attempt-local");
  // The "pc" is this machine's own shell with its own home, running the real remote checkout
  // program; the start checkout is dirty, so the hire gets its own worktree from origin/main.
  const pc = join(root, "pc");
  await exec("git", ["clone", "-q", repo.origin, pc]);
  await writeFile(join(pc, "owner-notes.txt"), "the owner's own work\n");
  const fleet: HerdrFleet = { id: "pc", session: "default", ssh: { host: "fixture@pc", shell: "posix" } };
  const shell = async (command: string) =>
    (await exec("/bin/sh", ["-c", command], { env: { ...process.env, HOME: root } })).stdout;
  const freshness = await verifyRemoteHireCheckout(fleet, shell, pc, [], "Remote");
  expect(freshness).toMatchObject({
    outcome: "worktree",
    branch: expect.stringMatching(/^clankie\/remote-/u),
  });
  const launch = hireWorktreeLaunch(freshness)!;
  expect(launch).toEqual({
    branchRef: `refs/heads/${freshness.branch}`,
    head: (await git(repo.seed, "rev-parse", "origin/main")).stdout.trim(),
    capturedAt: expect.any(String),
  });
  // A hire that stayed in place made no branch of its own, so it records nothing.
  expect(hireWorktreeLaunch({ ...freshness, outcome: "fresh" })).toBeUndefined();

  const efficiency = new SeatEfficiencyStore(join(root, "seat-efficiency.json"));
  efficiency.assign("occupant-w1:p1", { owner, commitBaseline: (await readSeatCommitBaseline(local))! });
  efficiency.assign("occupant-pc:p2", { owner, launch });
  // The record is the lead's own: another conversation reads nothing, and it survives a restart.
  expect(efficiency.readLaunchBaseline("occupant-pc:p2", { conversationId: "other" })).toBeUndefined();
  const reopened = new SeatEfficiencyStore(join(root, "seat-efficiency.json"));
  expect(reopened.readLaunchBaseline("occupant-pc:p2", owner)).toEqual(launch);
  // It names no path on the PC, so local Git never reads one as this seat's worktree.
  expect(reopened.readCommitBaseline("occupant-pc:p2", owner)).toBeUndefined();

  const ledger = new ProjectHires(join(root, "project-hires.json"));
  const claude = ledger.reserve(settings(), "game", hire(local, { attempt: true }));
  running(ledger, claude.id, "w1:p1");
  const codex = ledger.reserve(
    settings(),
    "game",
    hire(freshness.workingDirectory!, { harness: "codex", fleet: "pc", attempt: true }),
  );
  running(ledger, codex.id, "pc:p2");

  // The PC attempt commits in its worktree and pushes its hire branch; so does the local one.
  const worktree = freshness.workingDirectory!;
  await writeFile(join(worktree, "fix.txt"), "pc fix\n");
  await git(worktree, "add", "fix.txt");
  await git(worktree, "commit", "-q", "-m", "pc fix");
  await git(worktree, "push", "-q", "origin", `HEAD:${freshness.branch!}`);
  const pcHead = (await git(worktree, "rev-parse", "HEAD")).stdout.trim();
  await git(local, "commit", "-q", "--allow-empty", "-m", "local fix");
  await git(local, "push", "-q", "origin", "HEAD:clankie/attempt-local");
  const localHead = (await git(local, "rev-parse", "HEAD")).stdout.trim();

  const github = await githubFixture(repo.origin);
  const service = createWorkItemsService({
    stateDirectory: root,
    githubToken: async () => "fixture-only",
    githubApiBase: github.baseUrl,
  });
  const settle = (record: { allocation: string; occupantId: string }) =>
    settleAttemptByMerge(
      ledger,
      record,
      (candidate) => attemptLaunch(efficiency.readLaunchBaseline(candidate.occupantId ?? "", owner)),
      (repository, launch) => service.mergedPull(repository, launch),
    );
  github.merged.set(freshness.branch!, [{ number: 21, mergedAt: minutesFromNow(1), head: pcHead }]);
  github.merged.set("clankie/attempt-local", [{ number: 22, mergedAt: minutesFromNow(2), head: localHead }]);
  // The local pane closes, yet the PC attempt merged first and wins.
  const settled = await settle({ allocation: claude.id, occupantId: "occupant-w1:p1" });
  expect(settled).toMatchObject({ outcome: "won", allocation: codex.id, superseded: ["w1:p1"] });
  expect(settled?.detail).toContain(`branch ${freshness.branch!}`);
  expect(settled?.detail).toContain("https://github.com/Volpestyle/clankie/pull/21");
  expect(ledger.allocation(codex.id)?.attemptWon).toEqual(expect.any(String));
  expect(ledger.allocation(claude.id)).toMatchObject({ supersededBy: codex.id });
  // The owner's start checkout on the PC was left as it was.
  expect(await readFile(join(pc, "owner-notes.txt"), "utf8")).toBe("the owner's own work\n");
});

it("a squash-merged attempt counts as landed by its pull request's head, though main holds none of its commits (#703)", async () => {
  const root = await scratch();
  const repo = await repository(root);
  const { git } = repo;
  const a = await repo.checkout("attempt-a", "clankie/attempt-a");
  const b = await repo.checkout("attempt-b", "clankie/attempt-b");
  const efficiency = new SeatEfficiencyStore(join(root, "seat-efficiency.json"));
  efficiency.assign("occupant-w1:p1", { owner, commitBaseline: (await readSeatCommitBaseline(a))! });
  efficiency.assign("occupant-w1:p2", { owner, commitBaseline: (await readSeatCommitBaseline(b))! });
  const ledger = new ProjectHires(join(root, "project-hires.json"));
  const claude = ledger.reserve(settings(), "game", hire(a, { attempt: true }));
  running(ledger, claude.id, "w1:p1");
  const codex = ledger.reserve(settings(), "game", hire(b, { harness: "codex", attempt: true }));
  running(ledger, codex.id, "w1:p2");

  // A makes two commits on its hire branch, and the project squash-merges them as one.
  for (const name of ["one", "two"]) {
    await writeFile(join(a, `${name}.txt`), `${name}\n`);
    await git(a, "add", `${name}.txt`);
    await git(a, "commit", "-q", "-m", name);
  }
  await git(a, "push", "-q", "origin", "HEAD:clankie/attempt-a");
  const aHead = (await git(a, "rev-parse", "HEAD")).stdout.trim();
  await git(repo.seed, "fetch", "-q", "origin");
  await git(repo.seed, "merge", "-q", "--squash", "origin/clankie/attempt-a");
  await git(repo.seed, "commit", "-q", "-m", "Attempt A (#30)");
  await git(repo.seed, "push", "-q", "origin", "HEAD:main");
  // Main has A's change in one new commit, and none of A's own commits.
  await git(repo.seed, "fetch", "-q", "origin");
  await expect(git(repo.seed, "merge-base", "--is-ancestor", aHead, "origin/main")).rejects.toThrow();
  expect((await git(repo.seed, "cherry", "origin/main", aHead)).stdout).toMatch(/^\+ /mu);
  // B merges later with an ordinary pull request.
  await git(b, "commit", "-q", "--allow-empty", "-m", "b");
  await git(b, "push", "-q", "origin", "HEAD:clankie/attempt-b");
  const bHead = (await git(b, "rev-parse", "HEAD")).stdout.trim();

  const github = await githubFixture(repo.origin);
  github.merged.set("clankie/attempt-a", [{ number: 30, mergedAt: minutesFromNow(1), head: aHead }]);
  github.merged.set("clankie/attempt-b", [{ number: 31, mergedAt: minutesFromNow(2), head: bHead }]);
  const service = createWorkItemsService({
    stateDirectory: root,
    githubToken: async () => "fixture-only",
    githubApiBase: github.baseUrl,
  });
  const settled = await settleAttemptByMerge(
    ledger,
    { allocation: codex.id, occupantId: "occupant-w1:p2" },
    (candidate) => attemptLaunch(efficiency.readLaunchBaseline(candidate.occupantId ?? "", owner)),
    (repository, launch) => service.mergedPull(repository, launch),
  );
  expect(settled).toMatchObject({ outcome: "won", allocation: claude.id, superseded: ["w1:p2"] });
  expect(settled?.detail).toContain("https://github.com/Volpestyle/clankie/pull/30");
  expect(ledger.allocation(codex.id)).toMatchObject({ supersededBy: claude.id });
});
