import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { checkoutGit, syncOwnerCheckout } from "@clankie/settings";
import { remoteCheckoutProgram, verifyRemoteHireCheckout } from "../src/captain/checkout-freshness.ts";
import type { HerdrFleet } from "../src/herdr-fleet.ts";
const exec = promisify(execFile);

it("default fleet reads skip Git checkout work and opted-in reads reuse the complete bounded observation", async () => {
  const { createCaptain } = await import("../src/captain/captain.ts");
  const { SettingsStore } = await import("@clankie/settings");
  const { createHerdrWatchRunner } = await import("../src/captain/herdr-watch.ts");
  const { CheckoutObservationCache } = await import("../src/captain/checkout-observation-cache.ts");
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-checkout-roster-")));
  const owner = join(root, "owner"),
    trace = join(root, "git-calls.jsonl"),
    bin = join(root, "bin");
  const originalPath = process.env.PATH;
  let captain: ReturnType<typeof createCaptain> | undefined;
  try {
    await exec("git", ["init", "--initial-branch=main", owner]);
    await checkoutGit(owner, ["config", "user.name", "Fixture"]);
    await checkoutGit(owner, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(owner, "base.txt"), "base\n");
    await checkoutGit(owner, ["add", "base.txt"]);
    await checkoutGit(owner, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "base",
    ]);
    await checkoutGit(owner, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    const linked = join(root, "linked"),
      second = join(root, "second");
    await checkoutGit(owner, ["worktree", "add", "--detach", linked, "HEAD"]);
    await checkoutGit(owner, ["worktree", "add", "--detach", second, "HEAD"]);
    const realGit = (await exec("/usr/bin/which", ["git"])).stdout.trim();
    await mkdir(bin);
    // Observe actual subprocesses; every invocation delegates unchanged to real Git.
    await writeFile(
      join(bin, "git"),
      `#!${process.execPath}\nconst {appendFileSync}=require('node:fs');\nconst {spawnSync}=require('node:child_process');\nappendFileSync(${JSON.stringify(trace)},JSON.stringify(process.argv.slice(2))+'\\n');\nconst child=spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{stdio:'inherit'});\nprocess.exit(child.status??1);\n`,
    );
    await chmod(join(bin, "git"), 0o755);
    await writeFile(trace, "");
    process.env.PATH = `${bin}:${originalPath}`;
    const row = {
      pane_id: "w1:p1",
      terminal_id: "checkout-fixture",
      agent: "codex",
      agent_status: "idle",
      title: "Fixture",
      cwd: linked,
      agent_session: { source: "herdr:codex", kind: "id", value: "checkout-fixture" },
    };
    let censusReads = 0;
    captain = createCaptain({ herdrAvailable: () => true } as import("../src/captain/deps.ts").CaptainDeps, {
      repoRoot: owner,
      stateDir: join(root, "state"),
      settings: new SettingsStore(join(root, "settings.json")),
      nativeHerdrRunner: createHerdrWatchRunner(undefined, async (args, signal) => {
        if (args[0] === "agent" && args[1] === "wait") {
          // A native changed-status wait must park while this fixture remains idle.
          return new Promise<string>((_resolve, reject) => {
            const cancel = () => reject(signal?.reason ?? Error("Aborted"));
            if (signal?.aborted) cancel();
            else signal?.addEventListener("abort", cancel, { once: true });
          });
        }
        return JSON.stringify({ result: { panes: [row], agent: row } });
      }),
      nativeCensusRunner: async () => {
        censusReads++;
        return {
          stdout: JSON.stringify({
            result: {
              snapshot: { agents: [row], panes: [row], workspaces: [], tabs: [] },
              agents: [row],
              panes: [row],
              workspaces: [],
            },
          }),
          stderr: "",
        };
      },
    });
    // Initial native admission captures its own commit baseline once. Measure
    // checkout reads after that existing work has reached the detached-HEAD refusal.
    await captain.serveOperatorConversation({ schemaVersion: 1, op: "roster" });
    for (let reads = 0; reads < 500; reads++) {
      const admission = await readFile(trace, "utf8");
      if (
        admission.includes('"symbolic-ref","--quiet","HEAD"') &&
        admission.includes('"rev-parse","--verify","HEAD"')
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const admission = await readFile(trace, "utf8");
    expect(admission).toContain('"symbolic-ref","--quiet","HEAD"');
    expect(admission).toContain('"rev-parse","--verify","HEAD"');
    expect(admission).not.toContain('"worktree","list"');
    await writeFile(trace, "");
    for (const op of ["roster", "fleet"] as const) {
      const result = await captain.serveOperatorConversation({ schemaVersion: 1, op });
      const seats =
        result.op === "roster" ? result.seats : result.op === "fleet" ? result.snapshot.seats : [];
      expect(seats.some((seat) => seat.workingDirectory === linked)).toBe(true);
      expect(seats.every((seat) => !("checkout" in seat))).toBe(true);
    }
    expect(await readFile(trace, "utf8")).toBe("");
    await checkoutGit(linked, ["switch", "-c", "worker-changes"]);
    await writeFile(join(linked, "worker.txt"), "worker commit\n");
    await checkoutGit(linked, ["add", "worker.txt"]);
    await checkoutGit(linked, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "worker",
    ]);
    const workerHead = (await checkoutGit(linked, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(linked, "draft.txt"), "worker draft\n");
    await writeFile(trace, "");
    const enriched = await captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "roster",
      includeCheckouts: true,
    });
    expect(enriched).toMatchObject({
      op: "roster",
      seats: expect.arrayContaining([
        expect.objectContaining({
          workingDirectory: linked,
          checkout: expect.objectContaining({
            path: linked,
            outcome: "observed",
            branch: "worker-changes",
            head: workerHead,
            ahead: 1,
            behind: 0,
            dirty: true,
          }),
        }),
      ]),
    });
    const firstTrace = await readFile(trace, "utf8");
    expect(firstTrace).toContain('"worktree","list"');
    const precedingCensus = censusReads;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await rm(join(linked, "draft.txt"));
    await writeFile(join(owner, "draft.txt"), "draft\n");
    const repeated = await captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "fleet",
      includeCheckouts: true,
    });
    expect(repeated).toMatchObject({
      op: "fleet",
      snapshot: {
        seats: expect.arrayContaining([
          expect.objectContaining({ checkout: expect.objectContaining({ path: linked, dirty: true }) }),
        ]),
      },
    });
    expect(censusReads).toBeGreaterThan(precedingCensus);
    expect(await readFile(trace, "utf8")).toBe(firstTrace);
    await captain.serveOperatorConversation({ schemaVersion: 1, op: "roster" });
    await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
    expect(await readFile(trace, "utf8")).toBe(firstTrace);
    const bounded = new CheckoutObservationCache(2);
    await bounded.observe(owner);
    await mkdir(join(linked, "src"));
    expect(await bounded.observe(join(linked, "src"))).toMatchObject({
      path: linked,
      branch: "worker-changes",
      dirty: false,
      ahead: 1,
    });
    expect(await bounded.observe(second)).toMatchObject({ path: second, branch: "", dirty: false, ahead: 0 });
    await writeFile(trace, "");
    expect(await bounded.observe(owner)).toMatchObject({ path: owner, dirty: true });
    expect(await readFile(trace, "utf8")).toContain('"worktree","list"');
  } finally {
    await captain?.close();
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
it("remote observer enforces fetched main and cleanliness in a real child process", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-remote-freshness-")));
  try {
    const origin = join(root, "origin.git"),
      owner = join(root, "owner"),
      writer = join(root, "writer");
    await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
    await exec("git", ["clone", origin, owner]);
    await checkoutGit(owner, ["config", "user.name", "Fixture"]);
    await checkoutGit(owner, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(owner, "base.txt"), "base\n");
    await checkoutGit(owner, ["add", "base.txt"]);
    await checkoutGit(owner, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "base",
    ]);
    await checkoutGit(owner, ["push", "origin", "main"]);
    const observe = async () =>
      JSON.parse((await exec(process.execPath, ["-e", remoteCheckoutProgram(owner)])).stdout);
    expect(await observe()).toMatchObject({ outcome: "fresh" });
    await exec("git", ["clone", origin, writer]);
    await checkoutGit(writer, ["config", "user.name", "Fixture"]);
    await checkoutGit(writer, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(writer, "base.txt"), "remote\n");
    await checkoutGit(writer, ["add", "base.txt"]);
    await checkoutGit(writer, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "advance",
    ]);
    await checkoutGit(writer, ["push", "origin", "main"]);
    const before = (await checkoutGit(owner, ["rev-parse", "HEAD"])).trim();
    const alias = join(root, "owner-alias");
    await symlink(owner, alias, "dir");
    const missing = join(root, "missing-live-pane");
    for (const [census, reason] of [
      [null, "Live checkout census unavailable"],
      [[alias], `Start checkout belongs to a live pane: ${JSON.stringify(alias)}`],
      [[missing], `Live pane checkout unavailable: ${JSON.stringify(missing)}`],
    ] as const) {
      const protectedStart = JSON.parse(
        (
          await exec(process.execPath, [
            "-e",
            remoteCheckoutProgram(owner, census === null ? null : [...census]),
          ])
        ).stdout,
      );
      expect(protectedStart.outcome).toBe("refused");
      expect(protectedStart.reason).toContain(reason);
      expect((await checkoutGit(owner, ["rev-parse", "HEAD"])).trim()).toBe(before);
    }
    await mkdir(join(root, ".clankie"));
    await symlink(owner, join(root, ".clankie", "pinned"), "dir");
    const runtimeStart = JSON.parse(
      (
        await exec(process.execPath, ["-e", remoteCheckoutProgram(owner)], {
          env: { ...process.env, HOME: root },
        })
      ).stdout,
    );
    expect(runtimeStart.outcome).toBe("refused");
    expect(runtimeStart.reason).toContain("Managed runtime checkout");
    expect((await checkoutGit(owner, ["rev-parse", "HEAD"])).trim()).toBe(before);
    expect(await observe()).toMatchObject({
      outcome: "fresh",
      head: (await checkoutGit(writer, ["rev-parse", "HEAD"])).trim(),
    });
    expect((await syncOwnerCheckout(owner)).outcome).toBe("current");
    await writeFile(join(owner, "draft.txt"), "dirty\n");
    expect(await observe()).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining('"draft.txt"'),
    });
    expect(await readFile(join(owner, "draft.txt"), "utf8")).toBe("dirty\n");
    await rm(join(owner, "draft.txt"));
    await checkoutGit(owner, ["remote", "set-url", "origin", join(root, "missing-origin.git")]);
    const fleet: HerdrFleet = {
      id: "fixture",
      session: "default",
      ssh: { host: "fixture.invalid", shell: "posix" },
    };
    const failedFetch = await verifyRemoteHireCheckout(
      fleet,
      async (command) => (await exec("/bin/sh", ["-c", command])).stdout,
      owner,
    );
    expect(failedFetch).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining("missing-origin.git"),
    });
    expect(failedFetch.reason).toContain("does not appear to be a git repository");
    await checkoutGit(owner, [
      "remote",
      "set-url",
      "origin",
      "https://fixture:private-password@127.0.0.1:1/unreachable.git",
    ]);
    const unreachable = await verifyRemoteHireCheckout(
      fleet,
      async (command) => (await exec("/bin/sh", ["-c", command])).stdout,
      owner,
    );
    expect(unreachable).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining("Failed to connect"),
    });
    expect(unreachable.reason).toContain("[redacted-url]");
    expect(unreachable.reason).not.toContain("private-password");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("the real captain starts a dirty hire in a fresh worktree, refuses one in its own runtime, and serves checkout maintenance through the authenticated CLI/API", async () => {
  const { createCaptain } = await import("../src/captain/captain.ts");
  const { createClankieApp } = await import("../src/app.ts");
  const { SettingsStore } = await import("@clankie/settings");
  const { createHerdrWatchRunner } = await import("../src/captain/herdr-watch.ts");
  const { ProjectSchema } = await import("@clankie/protocol/projects");
  const { CheckoutReportSchema } = await import("@clankie/protocol");
  const { runCheckoutsCommand } = await import("../../tui/src/command/checkouts.ts");
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-checkouts-api-")));
  const origin = join(root, "origin.git"),
    owner = join(root, "owner");
  let captain: ReturnType<typeof createCaptain> | undefined;
  let service: Awaited<ReturnType<typeof createClankieApp>> | undefined;
  try {
    await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
    await exec("git", ["clone", origin, owner]);
    await checkoutGit(owner, ["config", "user.name", "Fixture"]);
    await checkoutGit(owner, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(owner, "base.txt"), "base\n");
    await mkdir(join(owner, "app"));
    await writeFile(join(owner, "app", "main.txt"), "app\n");
    await checkoutGit(owner, ["add", "base.txt", "app/main.txt"]);
    await checkoutGit(owner, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "base",
    ]);
    await checkoutGit(owner, ["push", "origin", "main"]);
    const settings = new SettingsStore(join(root, "settings.json"));
    await settings.update((current) => ({
      ...current,
      projects: {
        ...current.projects,
        projects: [
          ...current.projects.projects,
          ProjectSchema.parse({
            id: "checkout-fixture",
            name: "Checkout fixture",
            workspaces: [
              {
                id: "owner",
                machineId: "local",
                platform: process.platform === "win32" ? "windows" : "posix",
                path: join(owner, "app"),
              },
            ],
          }),
        ],
      },
    }));
    captain = createCaptain({ herdrAvailable: () => true } as import("../src/captain/deps.ts").CaptainDeps, {
      repoRoot: owner,
      stateDir: join(root, "state"),
      settings,
      nativeHerdrRunner: createHerdrWatchRunner(() => false),
    });
    await writeFile(join(owner, "draft.txt"), "keep owner draft\n");
    expect(
      await captain.serveOperatorConversation({
        schemaVersion: 1,
        op: "spawn_seat",
        conversationId: "global-default",
        seat: { schemaVersion: 1, harness: "codex", title: "Fixture", workingDirectory: owner },
        brief: "implement",
      }),
    ).toMatchObject({
      op: "spawn_seat",
      result: {
        outcome: "failed",
        reason: "not_ready",
        detail:
          "Start checkout has uncommitted changes in 1 file; Start checkout is a managed runtime; preserve its pinned HEAD",
      },
    });
    // The service's own runtime holds no hire worktree; any other dirty checkout gets one.
    const elsewhereState = join(root, "state-elsewhere");
    const hireElsewhere = async (workingDirectory = join(owner, "app")) => {
      const elsewhere = createCaptain(
        { herdrAvailable: () => true } as import("../src/captain/deps.ts").CaptainDeps,
        {
          repoRoot: join(root, "runtime"),
          stateDir: elsewhereState,
          settings,
          nativeHerdrRunner: createHerdrWatchRunner(() => false),
        },
      );
      try {
        return await elsewhere.serveOperatorConversation({
          schemaVersion: 1,
          op: "spawn_seat",
          conversationId: "global-default",
          seat: {
            schemaVersion: 1,
            harness: "codex",
            title: "Fixture",
            workingDirectory,
            projectId: "checkout-fixture",
            effort: "low",
            effortReason: "A fixture hire only needs to reach the native launch.",
          },
          brief: "implement",
        });
      } finally {
        await elsewhere.close();
      }
    };
    const hireWorktrees = async () =>
      [
        ...(await checkoutGit(owner, ["worktree", "list", "--porcelain"])).matchAll(
          /worktree ([^\n]*\/\.local\/wt-fixture-[a-f0-9]{6})\nHEAD [a-f0-9]+\nbranch refs\/heads\/clankie\/fixture-[a-f0-9]{6}\n/gu,
        ),
      ].map((match) => match[1]);
    // Freshness passed and the worktree's `app` twin kept the project registered at `owner/app`:
    // the hire got as far as choosing a harness.
    expect(await hireElsewhere()).toMatchObject({
      op: "spawn_seat",
      result: { reason: "harness_unavailable" },
    });
    const [first] = await hireWorktrees();
    expect(first).toBeDefined();
    expect(await checkoutGit(owner, ["status", "--porcelain=v1"])).toBe("?? draft.txt\n");
    // That launch is still unresolved, so retrying it returns to its worktree, never a second one.
    const receipts = join(elsewhereState, "herdr-watches.json.hire-receipts.json");
    await writeFile(
      receipts,
      JSON.stringify({
        [JSON.stringify(["local", "codex", join(first!, "app"), "new"])]: {
          messageId: "fixture-uncertain-launch",
          fingerprint: "",
        },
      }),
    );
    await hireElsewhere();
    expect(await hireWorktrees()).toEqual([first]);
    // Age alone never drops the way back to a launch that is still fenced: another start
    // folder's relocation is recorded, and the retry still returns to the first worktree.
    const ledger = join(elsewhereState, "hire-worktrees.json");
    const aged = Object.fromEntries(
      Object.entries(JSON.parse(await readFile(ledger, "utf8")) as Record<string, { at: string }>).map(
        ([scope, entry]) => [scope, { ...entry, at: "2026-01-01T00:00:00.000Z" }],
      ),
    );
    await writeFile(ledger, JSON.stringify(aged));
    await hireElsewhere(owner);
    expect(await hireWorktrees()).toHaveLength(2);
    await hireElsewhere();
    expect(await hireWorktrees()).toHaveLength(2);
    // Once that launch is resolved, the next hire from the still-dirty checkout gets its own.
    await rm(receipts);
    await hireElsewhere();
    expect(await hireWorktrees()).toHaveLength(3);
    expect(await checkoutGit(owner, ["status", "--porcelain=v1"])).toBe("?? draft.txt\n");
    service = await createClankieApp({
      captain,
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === "Bearer fixture-owner"
          ? { operatorId: "fixture-owner" }
          : undefined,
    });
    const app = service.app;
    const cli = {
      host: "http://fixture.invalid",
      env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" },
      fetchImpl: async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        app.fetch(new Request(input, init)),
    };
    const report = CheckoutReportSchema.parse(await runCheckoutsCommand(["status"], cli));
    expect(report.checkouts).toContainEqual(expect.objectContaining({ path: owner, dirty: true, behind: 0 }));
    expect(await runCheckoutsCommand(["sync", "--repository", owner], cli)).toMatchObject([
      { path: owner, outcome: "current" },
    ]);
    await expect(runCheckoutsCommand(["sync", "--repository", root], cli)).rejects.toThrow("409");
    await expect(
      runCheckoutsCommand(["status"], { ...cli, env: { CLANKIE_OPERATOR_TOKEN: "wrong-owner" } }),
    ).rejects.toThrow("401");
    expect(await readFile(join(owner, "draft.txt"), "utf8")).toBe("keep owner draft\n");
  } finally {
    service?.close();
    await captain?.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("remote observer starts a hire in a fresh worktree beside a dirty, divergent or live start checkout", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-remote-worktree-")));
  try {
    const origin = join(root, "origin.git"),
      owner = join(root, "owner"),
      writer = join(root, "writer");
    const commit = async (checkout: string, file: string, text: string, message: string) => {
      await writeFile(join(checkout, file), text);
      await checkoutGit(checkout, ["add", file]);
      await checkoutGit(checkout, [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        message,
      ]);
    };
    await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
    for (const checkout of [owner, writer]) {
      await exec("git", ["clone", origin, checkout]);
      await checkoutGit(checkout, ["config", "user.name", "Fixture"]);
      await checkoutGit(checkout, ["config", "user.email", "fixture@example.invalid"]);
      if (checkout === owner) {
        await commit(owner, "base.txt", "base\n", "base");
        await checkoutGit(owner, ["push", "origin", "main"]);
      }
    }
    await checkoutGit(writer, ["pull", "--ff-only", "origin", "main"]);
    await commit(writer, "base.txt", "remote\n", "advance");
    await checkoutGit(writer, ["push", "origin", "main"]);
    const remoteMain = (await checkoutGit(writer, ["rev-parse", "HEAD"])).trim();
    const fleet: HerdrFleet = {
      id: "fixture",
      session: "default",
      ssh: { host: "fixture.invalid", shell: "posix" },
    };
    const shell = async (command: string) => (await exec("/bin/sh", ["-c", command])).stdout;
    const before = (await checkoutGit(owner, ["rev-parse", "HEAD"])).trim();

    // Dirty, in a repository that does not ignore `.local`: the start checkout's status is unchanged.
    await writeFile(join(owner, "draft.txt"), "owner draft\n");
    const status = await checkoutGit(owner, ["status", "--porcelain=v1", "-z"]);
    const dirty = await verifyRemoteHireCheckout(fleet, shell, owner, [], "Nell");
    expect(dirty).toMatchObject({
      outcome: "worktree",
      start: owner,
      startReason: "Start checkout has uncommitted changes in 1 file",
      head: remoteMain,
      remoteMain,
      branch: expect.stringMatching(/^clankie\/nell-[a-f0-9]{6}$/u),
      path: expect.stringMatching(/\/\.local\/wt-nell-[a-f0-9]{6}$/u),
    });
    expect(dirty.workingDirectory).toBe(dirty.path);
    expect(await checkoutGit(owner, ["status", "--porcelain=v1", "-z"])).toBe(status);
    expect(await readFile(join(owner, ".git", "info", "exclude"), "utf8")).toContain("/.local/\n");
    expect((await checkoutGit(owner, ["rev-parse", "HEAD"])).trim()).toBe(before);
    expect(await readFile(join(dirty.path, "base.txt"), "utf8")).toBe("remote\n");
    // A hire started inside that dirty worktree gets its own, nested one.
    await writeFile(join(dirty.path, "scratch.txt"), "worker scratch\n");
    const nested = await verifyRemoteHireCheckout(fleet, shell, dirty.path, [], "Ari");
    expect(nested).toMatchObject({
      outcome: "worktree",
      start: dirty.path,
      path: expect.stringMatching(/\/\.local\/wt-nell-[a-f0-9]{6}\/\.local\/wt-ari-[a-f0-9]{6}$/u),
    });
    await rm(join(dirty.path, "scratch.txt"));
    // Without a worktree name the guard still refuses.
    expect(await verifyRemoteHireCheckout(fleet, shell, owner, [])).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining('"draft.txt"'),
    });
    await rm(join(owner, "draft.txt"));

    // Behind and owned by a live pane: the pane's HEAD stays where it was.
    const live = await verifyRemoteHireCheckout(fleet, shell, owner, [owner], "Nell");
    expect(live).toMatchObject({
      outcome: "worktree",
      startReason: `Start checkout was not advanced: Start checkout belongs to a live pane: ${JSON.stringify(owner)}`,
    });
    expect((await checkoutGit(owner, ["rev-parse", "HEAD"])).trim()).toBe(before);

    // Divergent: the local commit stays; the hire starts in the twin of its subfolder.
    await mkdir(join(owner, "apps"));
    await commit(owner, "apps/game.txt", "local\n", "local work");
    const localHead = (await checkoutGit(owner, ["rev-parse", "HEAD"])).trim();
    await mkdir(join(writer, "apps"));
    await commit(writer, "apps/game.txt", "main\n", "main work");
    await checkoutGit(writer, ["push", "origin", "main"]);
    const diverged = await verifyRemoteHireCheckout(fleet, shell, join(owner, "apps"), null, "Nell");
    expect(diverged).toMatchObject({
      outcome: "worktree",
      startReason: "Start checkout has commits that origin/main does not",
      workingDirectory: expect.stringMatching(/\/\.local\/wt-nell-[a-f0-9]{6}\/apps$/u),
    });
    expect(await readFile(join(diverged.workingDirectory!, "game.txt"), "utf8")).toBe("main\n");
    expect((await checkoutGit(owner, ["rev-parse", "HEAD"])).trim()).toBe(localHead);

    // A managed runtime holds no worktree.
    await mkdir(join(root, ".clankie"));
    await symlink(owner, join(root, ".clankie", "pinned"), "dir");
    const runtime = JSON.parse(
      (
        await exec(process.execPath, ["-e", remoteCheckoutProgram(owner, [], "nell")], {
          env: { ...process.env, HOME: root },
        })
      ).stdout,
    );
    expect(runtime).toMatchObject({
      outcome: "refused",
      reason: expect.stringContaining("Managed runtime checkout"),
    });
    expect(
      (await checkoutGit(owner, ["worktree", "list", "--porcelain"])).match(
        /\.local\/wt-nell-[a-f0-9]{6}\n/gu,
      ),
    ).toHaveLength(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("overlapping hires from one dirty start folder queue, and the second returns to the first's still-fenced worktree", async () => {
  const { vi } = await import("vitest");
  const { createCaptain } = await import("../src/captain/captain.ts");
  const { SettingsStore } = await import("@clankie/settings");
  const { HerdrWatchStore, createHerdrWatchRunner } = await import("../src/captain/herdr-watch.ts");
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-hire-overlap-")));
  const origin = join(root, "origin.git"),
    owner = join(root, "owner");
  let captain: ReturnType<typeof createCaptain> | undefined;
  try {
    await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
    await exec("git", ["clone", origin, owner]);
    await checkoutGit(owner, ["config", "user.name", "Fixture"]);
    await checkoutGit(owner, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(owner, "base.txt"), "base\n");
    await checkoutGit(owner, ["add", "base.txt"]);
    await checkoutGit(owner, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "base",
    ]);
    await checkoutGit(owner, ["push", "origin", "main"]);
    await writeFile(join(owner, "draft.txt"), "keep owner draft\n");
    // Only the native launch is stood in for: the first one stays unconfirmed, so its
    // worktree remains fenced, as a real uncertain launch's allocation and receipt do.
    const fenced = new Set<string>();
    const launched: string[] = [];
    vi.spyOn(HerdrWatchStore.prototype, "hireRetained").mockImplementation((input) =>
      fenced.has(input.workingDirectory),
    );
    vi.spyOn(HerdrWatchStore.prototype, "spawnSeat").mockImplementation(async (seat) => {
      launched.push(seat.workingDirectory);
      fenced.add(seat.workingDirectory);
      return { outcome: "failed", reason: "start_unconfirmed", detail: "fixture launch unconfirmed" };
    });
    captain = createCaptain({ herdrAvailable: () => true } as import("../src/captain/deps.ts").CaptainDeps, {
      repoRoot: join(root, "runtime"),
      stateDir: join(root, "state"),
      settings: new SettingsStore(join(root, "settings.json")),
      nativeHerdrRunner: createHerdrWatchRunner(() => false),
    });
    const hire = () =>
      captain!.serveOperatorConversation({
        schemaVersion: 1,
        op: "spawn_seat",
        conversationId: "global-default",
        seat: {
          schemaVersion: 1,
          harness: "codex",
          title: "Fixture",
          workingDirectory: owner,
          effort: "low",
          effortReason: "A fixture hire only needs to reach the native launch.",
        },
        brief: "implement",
      });
    await Promise.all([hire(), hire()]);
    expect(launched).toHaveLength(2);
    expect(launched[0]).toMatch(/\/\.local\/wt-fixture-[a-f0-9]{6}$/u);
    expect(launched[1]).toBe(launched[0]);
    expect(
      (await checkoutGit(owner, ["worktree", "list", "--porcelain"])).match(/wt-fixture-/gu),
    ).toHaveLength(1);
    expect(await checkoutGit(owner, ["status", "--porcelain=v1"])).toBe("?? draft.txt\n");
  } finally {
    vi.restoreAllMocks();
    await captain?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("only the same harness and brief retry a folder's unresolved hire; other work and work after it settled get their own worktree (#614)", async () => {
  const { vi } = await import("vitest");
  const { createCaptain } = await import("../src/captain/captain.ts");
  const { SettingsStore } = await import("@clankie/settings");
  const { HerdrWatchStore, createHerdrWatchRunner } = await import("../src/captain/herdr-watch.ts");
  const { deliveryFingerprint } = await import("../src/captain/delivery-fence.ts");
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-hire-retry-")));
  const origin = join(root, "origin.git"),
    owner = join(root, "owner"),
    state = join(root, "state");
  try {
    await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
    await exec("git", ["clone", origin, owner]);
    await checkoutGit(owner, ["config", "user.name", "Fixture"]);
    await checkoutGit(owner, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(owner, "base.txt"), "base\n");
    await checkoutGit(owner, ["add", "base.txt"]);
    await checkoutGit(owner, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "base",
    ]);
    await checkoutGit(owner, ["push", "origin", "main"]);
    await writeFile(join(owner, "draft.txt"), "keep owner draft\n");
    // Only the native launch is stood in for; the real receipt journal decides what is unresolved.
    const launched: string[] = [];
    vi.spyOn(HerdrWatchStore.prototype, "spawnSeat").mockImplementation(async (seat) => {
      launched.push(seat.workingDirectory);
      return { outcome: "failed", reason: "start_unconfirmed", detail: "fixture launch unconfirmed" };
    });
    // A new captain for each hire reads the journals as a restarted service would.
    const hire = async (brief: string) => {
      const captain = createCaptain(
        { herdrAvailable: () => true } as import("../src/captain/deps.ts").CaptainDeps,
        {
          repoRoot: join(root, "runtime"),
          stateDir: state,
          settings: new SettingsStore(join(root, "settings.json")),
          nativeHerdrRunner: createHerdrWatchRunner(() => false),
        },
      );
      try {
        await captain.serveOperatorConversation({
          schemaVersion: 1,
          op: "spawn_seat",
          conversationId: "global-default",
          seat: {
            schemaVersion: 1,
            harness: "codex",
            title: "Fixture",
            workingDirectory: owner,
            effort: "low",
            effortReason: "A fixture hire only needs to reach the native launch.",
          },
          brief,
        });
      } finally {
        await captain.close();
      }
      return launched.at(-1)!;
    };
    const receipts = join(state, "herdr-watches.json.hire-receipts.json");
    /** The journal a restart mid-start leaves: the launch's receipt, pending or settled. */
    const original = async (worktree: string, settled: boolean) => {
      const key = JSON.stringify(["local", "codex", worktree, "new"]);
      const fingerprint = deliveryFingerprint("original brief");
      await writeFile(
        receipts,
        JSON.stringify({
          [key]: {
            messageId: "4138f334-6487-4403-9418-49094b1fcf06",
            fingerprint,
            paneId: "herdr-core/t6v",
            ...(settled
              ? {
                  settlement: {
                    receiptId: "4138f334-6487-4403-9418-49094b1fcf06",
                    receiptKey: key,
                    fingerprint,
                    disposition: "adopted",
                    journal: "local-host-inventory",
                    census: { observedAt: 1, panes: 1, sha256: "0".repeat(64) },
                    pane: {
                      paneId: "herdr-core/t6v",
                      present: true,
                      terminalId: "herdr-core/t6v",
                      occupantId: "session-fixture",
                      owner: { conversationId: "global-default" },
                    },
                  },
                }
              : {}),
          },
        }),
      );
    };
    const first = await hire("original brief");
    expect(first).toMatch(/\/\.local\/wt-fixture-[a-f0-9]{6}$/u);
    await original(first, false);
    // A different brief from the same folder is new work, not that launch's retry.
    const other = await hire("another job");
    expect(other).not.toBe(first);
    // The same brief still returns to its own unresolved launch, never a second agent.
    expect(await hire("original brief")).toBe(first);
    // Once the original settled, a retry of it is still routed to its retained receipt
    // (which refuses a relaunch)...
    await original(first, true);
    expect(await hire("original brief")).toBe(first);
    // ...and new work from the folder goes elsewhere.
    const later = await hire("a third job");
    expect([first, other]).not.toContain(later);
    // A folder-only entry from before #614 holds new work only while its launch is pending.
    const ledger = join(state, "hire-worktrees.json");
    const entries = JSON.parse(await readFile(ledger, "utf8")) as Record<
      string,
      { workingDirectory: string }
    >;
    const [, entry] = Object.entries(entries).find(([, value]) => value.workingDirectory === first)!;
    await writeFile(ledger, JSON.stringify({ [JSON.stringify(["local", owner])]: entry }));
    await original(first, false);
    expect(await hire("unknown legacy brief")).toBe(first);
    await original(first, true);
    expect(await hire("unknown legacy brief")).not.toBe(first);
    expect(await checkoutGit(owner, ["status", "--porcelain=v1"])).toBe("?? draft.txt\n");
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});

it("a retry whose launch is still fenced in its clean start folder is never moved once that folder turns dirty", async () => {
  const { vi } = await import("vitest");
  const { createCaptain } = await import("../src/captain/captain.ts");
  const { SettingsStore } = await import("@clankie/settings");
  const { HerdrWatchStore, createHerdrWatchRunner } = await import("../src/captain/herdr-watch.ts");
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-hire-in-place-")));
  const origin = join(root, "origin.git"),
    owner = join(root, "owner");
  let captain: ReturnType<typeof createCaptain> | undefined;
  try {
    await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
    await exec("git", ["clone", origin, owner]);
    await checkoutGit(owner, ["config", "user.name", "Fixture"]);
    await checkoutGit(owner, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(owner, "base.txt"), "base\n");
    await checkoutGit(owner, ["add", "base.txt"]);
    await checkoutGit(owner, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "base",
    ]);
    await checkoutGit(owner, ["push", "origin", "main"]);
    // Only the native launch is stood in for: it stays unconfirmed, so its folder stays fenced.
    const fenced = new Set<string>();
    const launched: string[] = [];
    vi.spyOn(HerdrWatchStore.prototype, "hireUnresolved").mockImplementation((input) =>
      fenced.has(input.workingDirectory),
    );
    vi.spyOn(HerdrWatchStore.prototype, "spawnSeat").mockImplementation(async (seat) => {
      launched.push(seat.workingDirectory);
      fenced.add(seat.workingDirectory);
      return { outcome: "failed", reason: "start_unconfirmed", detail: "fixture launch unconfirmed" };
    });
    captain = createCaptain({ herdrAvailable: () => true } as import("../src/captain/deps.ts").CaptainDeps, {
      repoRoot: join(root, "runtime"),
      stateDir: join(root, "state"),
      settings: new SettingsStore(join(root, "settings.json")),
      nativeHerdrRunner: createHerdrWatchRunner(() => false),
    });
    const hire = () =>
      captain!.serveOperatorConversation({
        schemaVersion: 1,
        op: "spawn_seat",
        conversationId: "global-default",
        seat: {
          schemaVersion: 1,
          harness: "codex",
          title: "Fixture",
          workingDirectory: owner,
          effort: "low",
          effortReason: "A fixture hire only needs to reach the native launch.",
        },
        brief: "implement",
      });
    await hire();
    expect(launched).toEqual([owner]);
    await writeFile(join(owner, "draft.txt"), "keep owner draft\n");
    expect(await hire()).toMatchObject({
      op: "spawn_seat",
      result: {
        outcome: "failed",
        reason: "not_ready",
        detail: expect.stringContaining("Start checkout is dirty"),
      },
    });
    expect(launched).toEqual([owner]);
    expect(await checkoutGit(owner, ["worktree", "list", "--porcelain"])).not.toMatch(/wt-fixture-/u);
    expect(await checkoutGit(owner, ["status", "--porcelain=v1"])).toBe("?? draft.txt\n");
  } finally {
    vi.restoreAllMocks();
    await captain?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("an old unresolved start under another harness doesn't pin a new start to its dirty folder", async () => {
  const { vi } = await import("vitest");
  const { createCaptain } = await import("../src/captain/captain.ts");
  const { SettingsStore } = await import("@clankie/settings");
  const { HerdrWatchStore, createHerdrWatchRunner } = await import("../src/captain/herdr-watch.ts");
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-hire-other-harness-")));
  const origin = join(root, "origin.git"),
    owner = join(root, "owner");
  let captain: ReturnType<typeof createCaptain> | undefined;
  try {
    await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
    await exec("git", ["clone", origin, owner]);
    await checkoutGit(owner, ["config", "user.name", "Fixture"]);
    await checkoutGit(owner, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(owner, "base.txt"), "base\n");
    await checkoutGit(owner, ["add", "base.txt"]);
    await checkoutGit(owner, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "base",
    ]);
    await checkoutGit(owner, ["push", "origin", "main"]);
    await writeFile(join(owner, "draft.txt"), "keep owner draft\n");
    // A long-ago codex start in the start folder that never confirmed, as an owner's journal keeps it.
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(
      join(root, "state", "herdr-watches.json.project-hires.json"),
      JSON.stringify({
        version: 1,
        allocations: [
          {
            id: "old-codex-start",
            key: JSON.stringify(["default", owner]),
            projectId: "default",
            policy: JSON.stringify([null, null, null]),
            request: {
              schemaVersion: 1,
              harness: "codex",
              title: "Ada",
              workingDirectory: owner,
              effort: "low",
              effortReason: "An old fixture start.",
            },
            started: true,
            confirmed: false,
            gone: false,
          },
        ],
      }),
    );
    // Only the native launch is stood in for; which folder each start reaches is the evidence.
    const launched: string[] = [];
    vi.spyOn(HerdrWatchStore.prototype, "spawnSeat").mockImplementation(async (seat) => {
      launched.push(seat.workingDirectory);
      return { outcome: "failed", reason: "start_unconfirmed", detail: "fixture launch unconfirmed" };
    });
    captain = createCaptain({ herdrAvailable: () => true } as import("../src/captain/deps.ts").CaptainDeps, {
      repoRoot: join(root, "runtime"),
      stateDir: join(root, "state"),
      settings: new SettingsStore(join(root, "settings.json")),
      nativeHerdrRunner: createHerdrWatchRunner(() => false),
    });
    const hire = (harness: "claude" | "codex") =>
      captain!.serveOperatorConversation({
        schemaVersion: 1,
        op: "spawn_seat",
        conversationId: "global-default",
        seat: {
          schemaVersion: 1,
          harness,
          title: "Fixture",
          workingDirectory: owner,
          effort: "low",
          effortReason: "A fixture hire only needs to reach the native launch.",
        },
        brief: "implement",
      });
    await hire("claude");
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatch(/[/\\]\.local[/\\]wt-fixture-[0-9a-f]{6}$/u);
    // The same harness may be that old start's retry, so it stays in place and says why.
    expect(await hire("codex")).toMatchObject({
      op: "spawn_seat",
      result: {
        outcome: "failed",
        reason: "not_ready",
        detail: expect.stringMatching(
          /Start checkout is dirty.*an earlier codex start in this folder is still unresolved/su,
        ),
      },
    });
    expect(launched).toHaveLength(1);
    expect(await checkoutGit(owner, ["status", "--porcelain=v1"])).toBe("?? draft.txt\n");
  } finally {
    vi.restoreAllMocks();
    await captain?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("a settled original start no longer pins its dirty folder; a pending one still does (#721)", async () => {
  const { vi } = await import("vitest");
  const { createCaptain } = await import("../src/captain/captain.ts");
  const { SettingsStore } = await import("@clankie/settings");
  const { HerdrWatchStore, createHerdrWatchRunner } = await import("../src/captain/herdr-watch.ts");
  const { deliveryFingerprint } = await import("../src/captain/delivery-fence.ts");
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-hire-settled-")));
  const origin = join(root, "origin.git"),
    owner = join(root, "owner"),
    state = join(root, "state");
  try {
    await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
    await exec("git", ["clone", origin, owner]);
    await checkoutGit(owner, ["config", "user.name", "Fixture"]);
    await checkoutGit(owner, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(owner, "base.txt"), "base\n");
    await checkoutGit(owner, ["add", "base.txt"]);
    await checkoutGit(owner, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "base",
    ]);
    await checkoutGit(owner, ["push", "origin", "main"]);
    await writeFile(join(owner, "draft.txt"), "keep owner draft\n");
    // An earlier codex start in the start folder itself, kept under its original key as a
    // remote host's journal keeps it once recovery settled it.
    await mkdir(state, { recursive: true });
    const receipts = join(state, "herdr-watches.json.hire-receipts.json");
    const original = async (settled: boolean) => {
      const key = JSON.stringify(["local", "codex", owner, "new"]);
      const fingerprint = deliveryFingerprint("original brief");
      await writeFile(
        receipts,
        JSON.stringify({
          [key]: {
            messageId: "6f1c2a0e-3b7d-4e59-9a41-2d8e5c7b9f10",
            fingerprint,
            paneId: "herdr-core/t9q",
            ...(settled
              ? {
                  settlement: {
                    receiptId: "6f1c2a0e-3b7d-4e59-9a41-2d8e5c7b9f10",
                    receiptKey: key,
                    fingerprint,
                    disposition: "adopted",
                    journal: "local-host-inventory",
                    census: { observedAt: 1, panes: 1, sha256: "0".repeat(64) },
                    pane: {
                      paneId: "herdr-core/t9q",
                      present: true,
                      terminalId: "herdr-core/t9q",
                      occupantId: "session-fixture",
                      owner: { conversationId: "global-default" },
                    },
                  },
                }
              : {}),
          },
        }),
      );
    };
    // Only the native launch is stood in for; the real receipt journal decides what is unresolved.
    const launched: string[] = [];
    vi.spyOn(HerdrWatchStore.prototype, "spawnSeat").mockImplementation(async (seat) => {
      launched.push(seat.workingDirectory);
      return { outcome: "failed", reason: "start_unconfirmed", detail: "fixture launch unconfirmed" };
    });
    // A new captain for each hire reads the journals as a restarted service would.
    const hire = async () => {
      const captain = createCaptain(
        { herdrAvailable: () => true } as import("../src/captain/deps.ts").CaptainDeps,
        {
          repoRoot: join(root, "runtime"),
          stateDir: state,
          settings: new SettingsStore(join(root, "settings.json")),
          nativeHerdrRunner: createHerdrWatchRunner(() => false),
        },
      );
      try {
        return await captain.serveOperatorConversation({
          schemaVersion: 1,
          op: "spawn_seat",
          conversationId: "global-default",
          seat: {
            schemaVersion: 1,
            harness: "codex",
            title: "Fixture",
            workingDirectory: owner,
            effort: "low",
            effortReason: "A fixture hire only needs to reach the native launch.",
          },
          brief: "new work",
        });
      } finally {
        await captain.close();
      }
    };
    // Still pending, it may be running unconfirmed: a new start is checked in place and refused.
    await original(false);
    expect(await hire()).toMatchObject({
      op: "spawn_seat",
      result: {
        outcome: "failed",
        reason: "not_ready",
        detail: expect.stringMatching(
          /Start checkout is dirty.*an earlier codex start in this folder is still unresolved/su,
        ),
      },
    });
    expect(launched).toEqual([]);
    // Settled, its key stays fenced but no longer holds the folder: new work gets a fresh worktree.
    await original(true);
    await hire();
    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatch(/[/\\]\.local[/\\]wt-fixture-[0-9a-f]{6}$/u);
    expect(await checkoutGit(owner, ["status", "--porcelain=v1"])).toBe("?? draft.txt\n");
  } finally {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});

it("new work after a remote folder's settled hire is admitted in its fresh worktree; a pending one still holds the folder", async () => {
  const { createCaptain } = await import("../src/captain/captain.ts");
  const { SettingsStore } = await import("@clankie/settings");
  const { createHerdrWatchRunner } = await import("../src/captain/herdr-watch.ts");
  const { DeliveryFence, ReceiptSchema } = await import("../src/captain/delivery-fence.ts");
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-remote-settled-")));
  const origin = join(root, "origin.git"),
    owner = join(root, "owner"),
    state = join(root, "state");
  try {
    await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
    await exec("git", ["clone", origin, owner]);
    await checkoutGit(owner, ["config", "user.name", "Fixture"]);
    await checkoutGit(owner, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(owner, "base.txt"), "base\n");
    await checkoutGit(owner, ["add", "base.txt"]);
    await checkoutGit(owner, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "base",
    ]);
    await checkoutGit(owner, ["push", "origin", "main"]);
    await writeFile(join(owner, "draft.txt"), "keep owner draft\n");
    // The "pc" machine is this Mac's own shell with its own home, so the real remote checkout
    // observer makes the worktree there; its Herdr is unreachable and nothing is signed in.
    const fleet: HerdrFleet = { id: "pc", session: "default", ssh: { host: "fixture@pc", shell: "posix" } };
    const shell = async (command: string) =>
      (await exec("/bin/sh", ["-c", command], { env: { ...process.env, HOME: root } })).stdout;
    // A remote start folder's settled original, in the production journal's shape (anonymized),
    // moved to this folder and host.
    const golden = JSON.parse(
      await readFile(
        new URL("./fixtures/hire-receipts/settled-start-folder-hire.json", import.meta.url),
        "utf8",
      ),
    );
    const baseKey = JSON.stringify(["pc", "codex", owner, "new"]);
    const target = { fleet: "pc", host: "fixture@pc", session: "default", shell: "posix" };
    // The owner linked "pc" and lets it take workers, as `clankie machine` records it.
    const { ClankieSettingsSchema, emptySettings } = await import("@clankie/settings");
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify(
        ClankieSettingsSchema.parse({
          ...emptySettings(),
          machines: [{ id: "pc", ssh: "fixture@pc", shell: "posix" }],
          machineAccess: { pc: "workers" },
          execution: {
            ...emptySettings().execution,
            connections: [{ id: "pc", machine: "pc", session: "default", ssh: fleet.ssh }],
          },
        }),
      ),
    );
    const receipts = join(state, "herdr-watches.json.hire-receipts.json");
    const original = async (settled: boolean) => {
      const { settlement, recoveryRequested: _recovery, ...pending } = golden;
      await mkdir(state, { recursive: true });
      await writeFile(
        receipts,
        JSON.stringify({
          [baseKey]: ReceiptSchema.parse({
            ...pending,
            remoteAdmission: { ...golden.remoteAdmission, target },
            ...(settled
              ? { recoveryRequested: true, settlement: { ...settlement, receiptKey: baseKey, target } }
              : {}),
          }),
        }),
      );
    };
    const hire = async (brief: string) => {
      // As a connected app's start_agent does, ask the journal what new work here needs.
      const freshIntent = new DeliveryFence(receipts).nextFreshIntent(baseKey);
      const captain = createCaptain(
        {
          herdrAvailable: () => true,
          fleets: {
            list: [fleet],
            run: () => async () => {
              throw Error("fixture Herdr is unreachable");
            },
            shell: () => shell,
            remoteWorkspace: async () => true,
          },
        } as unknown as import("../src/captain/deps.ts").CaptainDeps,
        {
          repoRoot: join(root, "runtime"),
          stateDir: state,
          settings: new SettingsStore(join(root, "settings.json")),
          nativeHerdrRunner: createHerdrWatchRunner(() => false),
        },
      );
      try {
        const answer = await captain.serveOperatorConversation({
          schemaVersion: 1,
          op: "spawn_seat",
          conversationId: "global-default",
          seat: {
            schemaVersion: 1,
            harness: "codex",
            title: "Fixture",
            workingDirectory: owner,
            fleet: "pc",
            ...(freshIntent === undefined ? {} : { freshIntent }),
            effort: "low",
            effortReason: "A fixture hire only needs to pass admission.",
          },
          brief,
        });
        if (answer.op !== "spawn_seat") throw Error(JSON.stringify(answer));
        return { freshIntent, result: answer.result };
      } finally {
        await captain.close();
      }
    };
    // Settled, the start folder is fenced only for its own original; new work moves to a
    // fresh worktree and is admitted there, not refused against the start folder's receipts.
    await original(true);
    const moved = await hire("new work after the settled hire");
    expect(moved.freshIntent).toMatchObject({ afterReceiptId: golden.messageId });
    // Past every receipt check, it stops only at the plan check: no codex account is signed in
    // on the fixture machine. Before, the fence refused it with "expected no retained receipt".
    expect(moved.result).toMatchObject({
      outcome: "failed",
      reason: "harness_unavailable",
      detail: expect.stringContaining("No observed plan can take this hire"),
    });
    const worktrees = await checkoutGit(owner, ["worktree", "list", "--porcelain"]);
    expect(worktrees).toMatch(/\/\.local\/wt-fixture-[0-9a-f]{6}\n/u);
    // Still pending, it may be running unconfirmed: a new start is checked in place and refused.
    await original(false);
    const held = await hire("new work while the original is pending");
    expect(held.freshIntent).toBeUndefined();
    expect(held.result).toMatchObject({
      outcome: "failed",
      reason: "not_ready",
      detail: expect.stringMatching(
        /Start checkout is dirty.*an earlier codex start in this folder is still unresolved/su,
      ),
    });
    expect(await checkoutGit(owner, ["worktree", "list", "--porcelain"])).toBe(worktrees);
    expect(await checkoutGit(owner, ["status", "--porcelain=v1"])).toBe("?? draft.txt\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("an overlapping hire while a clean in-place hire is still being admitted is never moved once the folder turns dirty", async () => {
  const { vi } = await import("vitest");
  const { createCaptain } = await import("../src/captain/captain.ts");
  const { SettingsStore } = await import("@clankie/settings");
  const { HerdrWatchStore, createHerdrWatchRunner } = await import("../src/captain/herdr-watch.ts");
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-hire-admitting-")));
  const origin = join(root, "origin.git"),
    owner = join(root, "owner");
  let captain: ReturnType<typeof createCaptain> | undefined;
  let admit!: () => void;
  const admitted = new Promise<void>((resolve) => (admit = resolve));
  try {
    await exec("git", ["init", "--bare", "--initial-branch=main", origin]);
    await exec("git", ["clone", origin, owner]);
    await checkoutGit(owner, ["config", "user.name", "Fixture"]);
    await checkoutGit(owner, ["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(owner, "base.txt"), "base\n");
    await checkoutGit(owner, ["add", "base.txt"]);
    await checkoutGit(owner, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "base",
    ]);
    await checkoutGit(owner, ["push", "origin", "main"]);
    // Only the native launch is stood in for: the first one is held before any allocation or
    // receipt exists, the window in which nothing in the herdr store fences its folder yet.
    const launched: string[] = [];
    vi.spyOn(HerdrWatchStore.prototype, "hireRetained").mockReturnValue(false);
    vi.spyOn(HerdrWatchStore.prototype, "hireUnresolved").mockReturnValue(false);
    vi.spyOn(HerdrWatchStore.prototype, "spawnSeat").mockImplementation(async (seat) => {
      launched.push(seat.workingDirectory);
      await admitted;
      return { outcome: "failed", reason: "start_unconfirmed", detail: "fixture launch unconfirmed" };
    });
    captain = createCaptain({ herdrAvailable: () => true } as import("../src/captain/deps.ts").CaptainDeps, {
      repoRoot: join(root, "runtime"),
      stateDir: join(root, "state"),
      settings: new SettingsStore(join(root, "settings.json")),
      nativeHerdrRunner: createHerdrWatchRunner(() => false),
    });
    const hire = () =>
      captain!.serveOperatorConversation({
        schemaVersion: 1,
        op: "spawn_seat",
        conversationId: "global-default",
        seat: {
          schemaVersion: 1,
          harness: "codex",
          title: "Fixture",
          workingDirectory: owner,
          effort: "low",
          effortReason: "A fixture hire only needs to reach the native launch.",
        },
        brief: "implement",
      });
    const first = hire();
    await vi.waitFor(() => expect(launched).toEqual([owner]));
    await writeFile(join(owner, "draft.txt"), "keep owner draft\n");
    expect(await hire()).toMatchObject({
      op: "spawn_seat",
      result: {
        outcome: "failed",
        reason: "not_ready",
        detail: expect.stringContaining("Start checkout is dirty"),
      },
    });
    admit();
    await first;
    expect(launched).toEqual([owner]);
    expect(await checkoutGit(owner, ["worktree", "list", "--porcelain"])).not.toMatch(/wt-fixture-/u);
    expect(await checkoutGit(owner, ["status", "--porcelain=v1"])).toBe("?? draft.txt\n");
  } finally {
    admit();
    vi.restoreAllMocks();
    await captain?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("the real captain leaves a read-only hire's folder exactly as it is, even an owner's dotfiles repository", async () => {
  const { createCaptain } = await import("../src/captain/captain.ts");
  const { SettingsStore } = await import("@clankie/settings");
  const { createHerdrWatchRunner } = await import("../src/captain/herdr-watch.ts");
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-read-only-home-")));
  const home = join(root, "home");
  let captain: ReturnType<typeof createCaptain> | undefined;
  try {
    // A home tracked as Git with no origin/main and work in progress (ADR 0320).
    await exec("git", ["init", "--initial-branch=main", home]);
    await writeFile(join(home, ".zshrc"), "export EDITOR=vi\n");
    captain = createCaptain({ herdrAvailable: () => true } as import("../src/captain/deps.ts").CaptainDeps, {
      repoRoot: join(root, "runtime"),
      stateDir: join(root, "state"),
      settings: new SettingsStore(join(root, "settings.json")),
      nativeHerdrRunner: createHerdrWatchRunner(() => false),
    });
    const hire = (readOnly: boolean) =>
      captain!.serveOperatorConversation({
        schemaVersion: 1,
        op: "spawn_seat",
        conversationId: "global-default",
        seat: {
          schemaVersion: 1,
          harness: "claude",
          title: "setup",
          workingDirectory: home,
          hireKind: "worker",
          ...(readOnly ? { readOnly: true as const } : {}),
          effort: "medium",
          effortReason: "A fixture hire only needs to reach the native launch.",
        },
        brief: "look around",
      });
    // An everyday hire checks the folder against origin/main first.
    expect(await hire(false)).toMatchObject({ result: { outcome: "failed", reason: "not_ready" } });
    // The read-only hire skips that preparation and reaches the harness itself.
    expect(await hire(true)).toMatchObject({ result: { reason: "harness_unavailable" } });
    expect(await checkoutGit(home, ["status", "--porcelain=v1"])).toBe("?? .zshrc\n");
    expect(
      (await checkoutGit(home, ["worktree", "list", "--porcelain"])).match(/^worktree /gmu),
    ).toHaveLength(1);
  } finally {
    await captain?.close();
    await rm(root, { recursive: true, force: true });
  }
});
