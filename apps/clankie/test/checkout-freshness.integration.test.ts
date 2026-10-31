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
                path: owner,
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
    const elsewhere = createCaptain(
      { herdrAvailable: () => true } as import("../src/captain/deps.ts").CaptainDeps,
      {
        repoRoot: join(root, "runtime"),
        stateDir: join(root, "state-elsewhere"),
        settings,
        nativeHerdrRunner: createHerdrWatchRunner(() => false),
      },
    );
    try {
      const hired = await elsewhere.serveOperatorConversation({
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
      // Freshness passed: the hire got as far as choosing a harness, from a new worktree.
      expect(hired).toMatchObject({ op: "spawn_seat", result: { reason: "harness_unavailable" } });
      const registered = await checkoutGit(owner, ["worktree", "list", "--porcelain"]);
      expect(registered).toMatch(
        /worktree [^\n]*\/\.local\/wt-fixture-[a-f0-9]{6}\nHEAD [a-f0-9]+\nbranch refs\/heads\/clankie\/fixture-[a-f0-9]{6}\n/u,
      );
      expect(await checkoutGit(owner, ["status", "--porcelain=v1"])).toBe("?? draft.txt\n");
    } finally {
      await elsewhere.close();
    }
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
      (await checkoutGit(owner, ["worktree", "list", "--porcelain"])).match(/\.local\/wt-nell-/gu),
    ).toHaveLength(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
