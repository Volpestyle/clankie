import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { SpawnOperatorSeatSchema, effectiveHireProfile } from "@clankie/protocol";
import { routeHerdrFleets } from "../src/captain/herdr-fleet-runner.ts";
import { assertRemoteHerdrArgs } from "../src/herdr-fleet.ts";
import { createHerdrWatchRunner, HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { createPreparedNativeHost } from "../src/captain/prepared-native-host.ts";

const exec = promisify(execFile);
const binary = process.env.VUH1550_HERDR_BINARY ?? "herdr";

it("places new hires through real Herdr CLI/socket in repo workspaces and deliberate pipeline tabs without touching existing lanes", async () => {
  const root = await mkdtemp("/tmp/cl1550-");
  const home = join(root, "home");
  await mkdir(home);
  const config = join(root, "config.toml");
  await writeFile(
    config,
    'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n[update]\nversion_check = false\nmanifest_check = false\n',
  );
  const socketPath = join(root, "api.sock");
  const session = `hire-layout-${root.split("-").at(-1)}`;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_RUNTIME_DIR: root,
    HERDR_CONFIG_PATH: config,
    HERDR_SOCKET_PATH: socketPath,
    TERM: "xterm-256color",
    SHELL: "/bin/sh",
  };
  const calls: { args: readonly string[]; result: unknown }[] = [];
  const run = async (args: readonly string[]) => {
    if (args[0] !== "server") assertRemoteHerdrArgs(args);
    const { stdout } = await exec(binary, ["--session", session, ...args], {
      env,
      cwd: root,
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    calls.push({ args, result: stdout.trim() ? JSON.parse(stdout) : null });
    return stdout;
  };
  const snapshot = async () => JSON.parse(await run(["api", "snapshot"])).result.snapshot;
  let server: ChildProcess | undefined;
  let logs = "";
  try {
    const repoA = join(root, "long-repository-path-".repeat(5), "alpha");
    const repoB = join(root, "other", "alpha");
    const worktree = join(root, "alpha-worker");
    const plain = join(root, "plain");
    await mkdir(repoB, { recursive: true });
    await mkdir(repoA, { recursive: true });
    await mkdir(plain);
    for (const cwd of [repoA, repoB]) {
      await exec("git", ["init", cwd], { env });
      await exec(
        "git",
        [
          "-C",
          cwd,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--allow-empty",
          "-m",
          "initial",
        ],
        { env },
      );
    }
    await exec("git", ["-C", repoA, "worktree", "add", "--detach", worktree], { env });
    server = spawn(binary, ["--session", session, "server"], {
      env,
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (chunk) => {
      logs += String(chunk);
    });
    server.stderr?.on("data", (chunk) => {
      logs += String(chunk);
    });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Herdr exited: ${logs}`);
      try {
        await snapshot();
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    if (!ready) throw new Error(`Herdr did not answer: ${logs}`);
    // Unrelated lane, deliberately focused. No later operation may rename,
    // move, close or split its pane merely because it has focus.
    const original = JSON.parse(
      await run(["workspace", "create", "--cwd", repoB, "--label", "Owner lane", "--focus"]),
    ).result;
    const mixed = JSON.parse(
      await run(["workspace", "create", "--cwd", repoA, "--label", "Legacy mixed lane", "--no-focus"]),
    ).result;
    await run([
      "tab",
      "create",
      "--workspace",
      mixed.workspace.workspace_id,
      "--cwd",
      repoB,
      "--label",
      "Unrelated repo",
      "--no-focus",
    ]);
    const before = await snapshot();
    const runner = createHerdrWatchRunner(undefined, run);
    const request = (cwd: string, title: string, pipeline?: string) =>
      SpawnOperatorSeatSchema.parse({
        schemaVersion: 1,
        ...effectiveHireProfile({}, { placement: "new-tab", harness: "codex" }),
        workingDirectory: cwd,
        title,
        role: "implementer",
        ...(pipeline ? { pipeline, placement: "split" } : {}),
      });
    const first = request(repoA, "Noor");
    const firstPane = await runner.createTab!({
      cwd: first.workingDirectory,
      label: `${first.title} · ${first.role}`,
      placement: first.placement!,
    });
    const secondRunner = createHerdrWatchRunner(undefined, run); // no in-memory identity shortcut
    const secondPane = await secondRunner.createTab!({ cwd: worktree, label: "Rafa · reviewer" });
    const afterSolo = await snapshot();
    const p1 = afterSolo.panes.find((p: any) => p.pane_id === firstPane);
    const p2 = afterSolo.panes.find((p: any) => p.pane_id === secondPane);
    expect(p1.workspace_id).toBe(p2.workspace_id);
    expect(p1.workspace_id).not.toBe(original.workspace.workspace_id);
    expect(p1.workspace_id).not.toBe(mixed.workspace.workspace_id);
    expect(p1.tab_id).not.toBe(p2.tab_id);
    expect(afterSolo.workspaces.find((w: any) => w.workspace_id === p1.workspace_id).label).toBe("alpha");
    expect(afterSolo.tabs.find((t: any) => t.tab_id === p1.tab_id).label).toBe("Noor · implementer");
    expect(afterSolo.tabs.find((t: any) => t.tab_id === p2.tab_id).label).toBe("Rafa · reviewer");
    expect(afterSolo.focused_pane_id).toBe(before.focused_pane_id);
    // Same basename, different repo identity: reuse B's existing workspace.
    const third = await runner.createTab!({ cwd: repoB, label: "Mei · designer" });
    expect((await snapshot()).panes.find((p: any) => p.pane_id === third).workspace_id).toBe(
      original.workspace.workspace_id,
    );
    // Named pipeline is explicit; later stages split the preceding new stage.
    const pipeline = request(
      repoA,
      "Ari",
      "VUH-1550 design → implement → review " + "long workflow name ".repeat(5),
    );
    const stages = [
      await runner.createTab!({
        cwd: repoA,
        label: "Ari · designer",
        pipeline: pipeline.pipeline!,
        placement: pipeline.placement!,
      }),
    ];
    stages.push(
      await secondRunner.createTab!({
        cwd: worktree,
        label: "Teo · implementer",
        pipeline: pipeline.pipeline!,
        placement: "split",
      }),
    );
    stages.push(
      await runner.createTab!({
        cwd: repoA,
        label: "Wren · reviewer",
        pipeline: pipeline.pipeline!,
        placement: "split",
      }),
    );
    const pipelineSnapshot = await snapshot();
    const stagePanes = stages.map((id) => pipelineSnapshot.panes.find((p: any) => p.pane_id === id));
    expect(new Set(stagePanes.map((p) => p.tab_id)).size).toBe(1);
    expect(pipelineSnapshot.tabs.find((t: any) => t.tab_id === stagePanes[0].tab_id).label).toBe(
      pipeline.pipeline,
    );
    expect(
      calls
        .filter((c) => c.args[0] === "pane" && c.args[1] === "split")
        .map((c) => c.args[c.args.indexOf("--pane") + 1]),
    ).toEqual(stages.slice(0, 2));
    // Unknown pipeline ownership and unnamed split fail without native effects.
    const count = pipelineSnapshot.panes.length;
    await expect(runner.createTab!({ cwd: repoA, label: "Zuri", placement: "split" })).rejects.toThrow(
      "named pipeline",
    );
    await expect(
      runner.createTab!({ cwd: repoA, label: "Zuri", pipeline: pipeline.pipeline!, placement: "new-tab" }),
    ).rejects.toThrow("already exists");
    await run([
      "tab",
      "create",
      "--workspace",
      p1.workspace_id,
      "--cwd",
      repoA,
      "--label",
      "Foreign workflow",
      "--no-focus",
    ]);
    const foreignBefore = await snapshot();
    await expect(
      runner.createTab!({ cwd: repoA, label: "Zuri", pipeline: "Foreign workflow", placement: "split" }),
    ).rejects.toThrow("not a verified");
    expect((await snapshot()).panes.length).toBe(foreignBefore.panes.length);
    expect(foreignBefore.panes.length).toBe(count + 1);
    // Non-Git directories also get an exact-cwd workspace reused on the socket.
    const routed = routeHerdrFleets(
      runner,
      async () => new Map([["fixture", createHerdrWatchRunner(undefined, run)]]),
    );
    const qualified = await Promise.all([
      routed.createTab!({ cwd: plain, label: "Sora · implementer", fleet: "fixture" }),
      routed.createTab!({ cwd: plain, label: "Ravi · reviewer", fleet: "fixture" }),
    ]);
    expect(qualified.every((id) => id.startsWith("fixture/"))).toBe(true);
    const [plainOne, plainTwo] = qualified.map((id) => id.slice("fixture/".length));
    const plainSnapshot = await snapshot();
    expect(plainSnapshot.panes.find((p: any) => p.pane_id === plainOne).workspace_id).toBe(
      plainSnapshot.panes.find((p: any) => p.pane_id === plainTwo).workspace_id,
    );
    // Prepared initial argv uses the same explicit workspace on the real socket.
    if (process.platform === "darwin") {
      const currentSession = JSON.parse(await run(["session", "list", "--json"])).sessions.find(
        (s: any) => s.name === session,
      );
      expect(currentSession?.running).toBe(true);
      const native = createPreparedNativeHost({
        harness: "pi",
        binding: async () => ({
          socketPath: currentSession.socket_path,
          session,
          runtime: "external" as const,
        }),
        processHelper: "unused-capture-helper",
      });
      const prepared = createHerdrWatchRunner(undefined, run, native.createCommandTab);
      const pane = await prepared.createTab!({
        cwd: repoA,
        label: "Juno · tester",
        command: ["/bin/sh", "-c", "sleep 60"],
      });
      expect((await snapshot()).panes.find((p: any) => p.pane_id === pane).workspace_id).toBe(
        p1.workspace_id,
      );
      await expect(
        prepared.createTab!({
          cwd: repoA,
          label: "Juno · tester",
          pipeline: pipeline.pipeline!,
          placement: "split",
          command: ["/bin/sh", "-c", "sleep 60"],
        }),
      ).rejects.toThrow("unsupported");
    }
    // Real transport fault after a successful mutation: preserve the uncertain
    // hire receipt across a new store instance, never start/retry a harness.
    const uncertainty: unknown[] = [];
    for (const fault of ["tab-reply", "pane-label"] as const) {
      let dropped = false;
      const faultRunner = createHerdrWatchRunner(undefined, async (args) => {
        const raw = await run(args);
        if (
          !dropped &&
          ((fault === "tab-reply" && args[0] === "tab" && args[1] === "create") ||
            (fault === "pane-label" && args[0] === "pane" && args[1] === "rename"))
        ) {
          dropped = true;
          throw new Error("Fixture dropped the real successful mutation reply");
        }
        return raw;
      });
      const path = join(root, `uncertain-${fault}.json`);
      const hire = SpawnOperatorSeatSchema.parse({
        schemaVersion: 1,
        harness: "claude",
        title: "Transport fault",
        role: "implementer",
        workingDirectory: plain,
      });
      const paneCount = (await snapshot()).panes.length;
      const store = new HerdrWatchStore(path, { runner: faultRunner });
      let firstResult;
      try {
        firstResult = await store.spawnSeat(hire);
        expect(firstResult).toMatchObject({
          outcome: "failed",
          reason: "start_unconfirmed",
          deliveryStage: "uncertain",
        });
      } finally {
        store.close();
      }
      const recreated = new HerdrWatchStore(path, { runner: faultRunner });
      let retry;
      try {
        retry = await recreated.spawnSeat(hire);
        expect(retry).toMatchObject({
          outcome: "failed",
          reason: "delivery_unconfirmed",
          deliveryStage: "uncertain",
        });
      } finally {
        recreated.close();
      }
      expect((await snapshot()).panes.length).toBe(paneCount + 1);
      uncertainty.push({ fault, firstResult, retry });
    }
    expect(calls.some((c) => c.args[0] === "agent" && c.args[1] === "start")).toBe(false);
    const final = await snapshot();
    expect(final.focused_pane_id).toBe(before.focused_pane_id);
    const untouched = final.panes.find((p: any) => p.pane_id === original.root_pane.pane_id);
    expect({
      workspace: untouched.workspace_id,
      tab: untouched.tab_id,
      terminal: untouched.terminal_id,
    }).toEqual({
      workspace: original.workspace.workspace_id,
      tab: original.tab.tab_id,
      terminal: original.root_pane.terminal_id,
    });
    expect(final.workspaces.find((w: any) => w.workspace_id === original.workspace.workspace_id).label).toBe(
      "Owner lane",
    );
    expect(final.panes.filter((p: any) => p.workspace_id === mixed.workspace.workspace_id)).toEqual(
      before.panes.filter((p: any) => p.workspace_id === mixed.workspace.workspace_id),
    );
    expect(final.tabs.filter((t: any) => t.workspace_id === mixed.workspace.workspace_id)).toEqual(
      before.tabs.filter((t: any) => t.workspace_id === mixed.workspace.workspace_id),
    );
    expect(calls.some((c) => c.args.includes("close") || c.args.includes("move"))).toBe(false);
    if (process.env.VUH1550_EVIDENCE) {
      await writeFile(
        join(process.env.VUH1550_EVIDENCE, "herdr-layout-journey.json"),
        JSON.stringify({ session, before, afterSolo, pipelineSnapshot, final, uncertainty, calls }, null, 2),
      );
    }
  } finally {
    if (process.env.VUH1550_EVIDENCE)
      await writeFile(
        join(process.env.VUH1550_EVIDENCE, "herdr-layout-calls.json"),
        JSON.stringify({ session, calls, logs }, null, 2),
      );
    if (server && server.exitCode === null) {
      const exited = new Promise<void>((resolve) => server!.once("exit", () => resolve()));
      await run(["server", "stop"]).catch(() => undefined);
      const timer = setTimeout(() => server!.kill("SIGTERM"), 1000);
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
      clearTimeout(timer);
      if (server.exitCode === null && server.signalCode === null) {
        server.kill("SIGKILL");
        await exited;
      }
      expect(server.exitCode !== null || server.signalCode !== null).toBe(true);
    }
    await rm(root, { recursive: true, force: true });
    if (process.env.VUH1550_EVIDENCE)
      await writeFile(
        join(process.env.VUH1550_EVIDENCE, "cleanup.json"),
        JSON.stringify(
          {
            session,
            serverPid: server?.pid,
            exitCode: server?.exitCode,
            signalCode: server?.signalCode,
            removedPrivateRoot: root,
          },
          null,
          2,
        ),
      );
  }
}, 30_000);
