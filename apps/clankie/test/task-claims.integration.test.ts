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
import { ProjectHires, settleAttemptByMerge } from "../src/captain/project-hires.ts";
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
  expect(ledger.settleAttempt(codex.id, "occupant-replaced")).toBeUndefined();
  // Codex's work lands first and its close released its allocation: the retained record
  // still wins, Claude's attempt is superseded, and a second settlement changes nothing.
  ledger.reconcile("default", new Set(["w1:p1"]), new Set(), ledger.inventoryCandidates("default"));
  expect(ledger.allocation(codex.id)?.gone).toBe(true);
  expect(ledger.settleAttempt(codex.id, "occupant-w1:p2")).toEqual(["w1:p1"]);
  expect(ledger.settleAttempt(codex.id, "occupant-w1:p2")).toBeUndefined();
  expect(ledger.settleAttempt(claude.id, "occupant-w1:p1")).toBeUndefined();
  expect(ledger.attempt("default", "w1:p1")).toMatchObject({ superseded: true });
  expect(ledger.allocation(codex.id)).toMatchObject({
    attemptWon: expect.any(String),
    request: { harness: "codex", model: "sol 6.1" },
  });
  expect(ledger.allocation(claude.id)).toMatchObject({ supersededBy: codex.id });
});

/**
 * GitHub as the host reads it: the repository's default branch and the pull requests
 * merged from each branch. Only what a test records here counts as a merge.
 */
const githubFixture = async () => {
  const merged = new Map<string, { number: number; mergedAt: string }>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture");
    let body: unknown = { message: "Not Found" };
    if (url.pathname === "/repos/Volpestyle/clankie") body = { default_branch: "main" };
    if (url.pathname === "/repos/Volpestyle/clankie/pulls") {
      const branch = url.searchParams.get("head")?.replace(/^Volpestyle:/u, "") ?? "";
      const pull = merged.get(branch);
      body = pull
        ? [
            {
              number: pull.number,
              html_url: `https://github.com/Volpestyle/clankie/pull/${pull.number}`,
              merged_at: pull.mergedAt,
              head: { ref: branch, repo: { full_name: "Volpestyle/clankie" } },
              base: { ref: "main" },
            },
          ]
        : [];
    }
    response.writeHead(Array.isArray(body) || "default_branch" in (body as object) ? 200 : 404, {
      "content-type": "application/json",
    });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${port}`, merged };
};

it("an attempt wins only by the pull request GitHub merged first from its hire branch, never by what its worktree writes", async () => {
  const root = await scratch();
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
  // Two attempts start from the same main in their own checkouts, each on the branch the
  // host recorded at its hire.
  const a = join(root, "attempt-a");
  const b = join(root, "attempt-b");
  await exec("git", ["clone", "-q", origin, a]);
  await exec("git", ["clone", "-q", origin, b]);
  await git(a, "switch", "-q", "-c", "clankie/attempt-a");
  await git(b, "switch", "-q", "-c", "clankie/attempt-b");
  const ledger = new ProjectHires(join(root, "project-hires.json"));
  const claude = ledger.reserve(settings(), "game", hire(a, { attempt: true }));
  running(ledger, claude.id, "w1:p1");
  const codex = ledger.reserve(settings(), "game", hire(b, { harness: "codex", attempt: true }));
  running(ledger, codex.id, "w1:p2");
  const hireBranch = new Map([
    ["occupant-w1:p1", "clankie/attempt-a"],
    ["occupant-w1:p2", "clankie/attempt-b"],
  ]);
  const github = await githubFixture();
  const service = createWorkItemsService({
    stateDirectory: root,
    githubToken: async () => "fixture-only",
    githubApiBase: github.baseUrl,
  });
  const settle = (record: { allocation: string; occupantId: string }) =>
    settleAttemptByMerge(
      ledger,
      record,
      (candidate) => hireBranch.get(candidate.occupantId ?? ""),
      (repository, branch) => service.mergedPull(repository, branch),
    );
  const closingB = { allocation: codex.id, occupantId: "occupant-w1:p2" };

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
  // Nothing the worktree says counts, and no attempt's hire branch merged: no winner.
  const forged = await settle(closingB);
  expect(forged).toMatchObject({ outcome: "unsettled" });
  expect(forged?.detail).toContain("no attempt's hire branch has a merged pull request");
  expect(forged?.detail).toContain("pane w1:p1, branch clankie/attempt-a");
  expect(forged?.detail).toContain("pane w1:p2, branch clankie/attempt-b");
  expect(ledger.allocation(codex.id)?.attemptWon).toBeUndefined();
  expect(ledger.allocation(claude.id)?.supersededBy).toBeUndefined();

  // B copies A's fix with a cherry-pick onto its own branch and pushes it.
  await git(b, "reset", "-q", "--hard", "origin/main~1");
  await git(b, "cherry-pick", landed);
  await git(b, "push", "-q", "origin", "HEAD:clankie/attempt-b");
  // The copy alone proves nothing either.
  expect(await settle(closingB)).toMatchObject({ outcome: "unsettled" });
  // A's hire branch merges as a pull request, then B merges its copied cherry-pick as its
  // own: A's merged first, so A wins even though B's pane is the one closing.
  github.merged.set("clankie/attempt-a", { number: 11, mergedAt: "2026-11-03T10:00:00Z" });
  github.merged.set("clankie/attempt-b", { number: 12, mergedAt: "2026-11-03T10:05:00Z" });
  const settled = await settle(closingB);
  expect(settled).toMatchObject({ outcome: "won", allocation: claude.id, superseded: ["w1:p2"] });
  expect(settled?.detail).toContain("https://github.com/Volpestyle/clankie/pull/11");
  expect(ledger.allocation(claude.id)?.attemptWon).toEqual(expect.any(String));
  expect(ledger.allocation(codex.id)).toMatchObject({ supersededBy: claude.id });
  expect(ledger.allocation(codex.id)?.attemptWon).toBeUndefined();
  // Settled once: a later close changes nothing.
  expect(await settle({ allocation: claude.id, occupantId: "occupant-w1:p1" })).toBeUndefined();
});

it("leaves an attempt unsettled when its deliverable names no GitHub issue or a hire branch is unknown", async () => {
  const root = await scratch();
  const ledger = new ProjectHires(join(root, "project-hires.json"));
  const one = ledger.reserve(
    settings(),
    "game",
    hire(join(root, "one"), { deliverable: "VUH-602", attempt: true }),
  );
  running(ledger, one.id, "w1:p1");
  const two = ledger.reserve(
    settings(),
    "game",
    hire(join(root, "two"), { deliverable: "VUH-602", harness: "codex", attempt: true }),
  );
  running(ledger, two.id, "w1:p2");
  const never = async () => {
    throw new Error("GitHub must not be read");
  };
  const record = { allocation: one.id, occupantId: "occupant-w1:p1" };
  expect((await settleAttemptByMerge(ledger, record, () => "b", never))?.detail).toContain(
    "the deliverable names no GitHub issue",
  );
  const github = ledger.reserve(
    settings(),
    "game",
    hire(join(root, "three"), { harness: "codex", attempt: true }),
  );
  running(ledger, github.id, "w1:p3");
  const remote = await settleAttemptByMerge(
    ledger,
    { allocation: github.id, occupantId: "occupant-w1:p3" },
    () => undefined,
    never,
  );
  expect(remote?.detail).toContain("no hire branch is recorded for codex (pane w1:p3)");
  expect(ledger.allocation(github.id)?.attemptWon).toBeUndefined();
});
