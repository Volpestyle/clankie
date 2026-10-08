import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { checkoutGit, syncOwnerCheckout } from "@clankie/settings";
import { remoteCheckoutProgram } from "../src/captain/checkout-freshness.ts";
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
          checkout: expect.objectContaining({ path: owner, outcome: "observed", dirty: false }),
        }),
      ]),
    });
    const firstTrace = await readFile(trace, "utf8");
    expect(firstTrace).toContain('"worktree","list"');
    const precedingCensus = censusReads;
    await new Promise((resolve) => setTimeout(resolve, 1100));
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
          expect.objectContaining({ checkout: expect.objectContaining({ dirty: false }) }),
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
    await bounded.observe(linked);
    await bounded.observe(second);
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
    for (const census of [null, [alias]]) {
      const protectedStart = JSON.parse(
        (await exec(process.execPath, ["-e", remoteCheckoutProgram(owner, census)])).stdout,
      );
      expect(protectedStart.outcome).toBe("refused");
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("the real captain refuses a dirty hire before launch and serves checkout maintenance through the authenticated CLI/API", async () => {
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
      result: { outcome: "failed", reason: "not_ready", detail: expect.stringContaining("dirty") },
    });
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
