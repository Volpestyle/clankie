import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createResourceGovernor } from "@clankie/fleet-resources";
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
    // The isolated Herdr server inherits an operator hook's command environment.
    CLANKIE_RESOURCE_HOLDER: "claude:operator-session",
    CODEX_THREAD_ID: "operator-thread",
    CLAUDE_SESSION_ID: "operator-session",
    CLAUDE_AGENT_ID: "operator-agent",
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
    calls.push({
      args,
      result: args[0] === "pane" && args[1] === "read" ? stdout : stdout.trim() ? JSON.parse(stdout) : null,
    });
    return stdout;
  };
  const snapshot = async () => JSON.parse(await run(["api", "snapshot"])).result.snapshot;
  let server: ChildProcess | undefined;
  let logs = "";
  const ownedClosedPanes: string[] = [];
  let firstHireSnapshot: unknown;
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
    // VUH-2031 residual edge: the first prepared command on an entirely
    // empty server still launches. Herdr needs a workspace before layout.apply,
    // so this fallback deliberately retains its starter shell.
    expect((await snapshot()).workspaces).toEqual([]);
    const firstSession = JSON.parse(await run(["session", "list", "--json"])).sessions.find(
      (s: any) => s.name === session,
    );
    const firstNative = createPreparedNativeHost({
      harness: "pi",
      binding: async () => ({ runtime: "external", socketPath: firstSession.socket_path, session }),
      processHelper: "unused-capture-helper",
    });
    const firstRunner = createHerdrWatchRunner(undefined, run, firstNative.createCommandTab);
    const holderProof = join(root, "worker-holder.json");
    const holderReady = join(root, "worker-ready");
    const holderRelease = join(root, "worker-release");
    const holderRegistry = join(root, "worker-registry");
    const workerScript = join(root, "worker-holder.mjs");
    await writeFile(
      workerScript,
      `
      import { writeFile } from "node:fs/promises";
      import { createResourceGovernor } from ${JSON.stringify(new URL("../../../packages/fleet-resources/src/index.ts", import.meta.url).href)};
      import { runHeavyCommand } from ${JSON.stringify(new URL("../../tui/src/command/heavy.ts", import.meta.url).href)};
      const inherited = Object.fromEntries(["CLANKIE_RESOURCE_HOLDER", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_AGENT_ID"].map(k => [k, process.env[k]]));
      // Native protocol fixture supplies its own executing thread, as Codex does.
      process.env.CODEX_THREAD_ID = "hired-worker-thread";
      const governor = createResourceGovernor({ directory: ${JSON.stringify(holderRegistry)}, probe: async () => ({loadRatio: 0, availableMemoryMb: 1000000}) });
      await writeFile(${JSON.stringify(holderProof)}, JSON.stringify(inherited));
      try {
        const code = await runHeavyCommand(["--", process.execPath, "-e", ${JSON.stringify("const fs=require('node:fs');fs.writeFileSync(process.argv[1],'ready');const timer=setInterval(()=>{if(fs.existsSync(process.argv[2]))clearInterval(timer)},20)")}, ${JSON.stringify(holderReady)}, ${JSON.stringify(holderRelease)}], {governor});
        if (code !== 0) throw new Error("Worker heavy child failed");
      } finally { await governor.close(); }
      setInterval(() => {}, 1000);
    `,
    );
    const firstPrepared = await firstRunner.createTab!({
      cwd: plain,
      label: "First prepared hire",
      env: { CLANKIE_RESOURCE_HOLDER: "claude:operator-session" },
      command: [process.execPath, "--import", fileURLToPath(import.meta.resolve("tsx")), workerScript],
    });
    const workerGovernor = createResourceGovernor({ directory: holderRegistry });
    try {
      let leases: Awaited<ReturnType<typeof workerGovernor.snapshot>>["leases"] = [];
      for (let i = 0; i < 200; i++) {
        leases = (await workerGovernor.snapshot()).leases;
        if (leases.length) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(JSON.parse(await readFile(holderProof, "utf8"))).toEqual({
        CLANKIE_RESOURCE_HOLDER: "",
        CODEX_THREAD_ID: "",
        CLAUDE_SESSION_ID: "",
        CLAUDE_AGENT_ID: "",
      });
      expect(leases).toHaveLength(1);
      expect(leases[0]).toMatchObject({ holderId: "codex:hired-worker-thread" });
      if (process.env.VUH1550_EVIDENCE)
        await writeFile(
          join(process.env.VUH1550_EVIDENCE, "worker-holder-lease.json"),
          JSON.stringify({ inherited: JSON.parse(await readFile(holderProof, "utf8")), leases }, null, 2),
        );
    } finally {
      await writeFile(holderRelease, "done");
      await workerGovernor.close();
    }
    const firstSnapshot = await snapshot();
    firstHireSnapshot = firstSnapshot;
    const firstMember = firstSnapshot.panes.find((p: any) => p.pane_id === firstPrepared);
    expect(firstMember).toBeDefined();
    const firstMembers = firstSnapshot.panes.filter((p: any) => p.workspace_id === firstMember.workspace_id);
    expect(firstMembers).toHaveLength(2);
    expect(
      JSON.parse(await run(["pane", "process-info", "--pane", firstPrepared])).result.process_info.shell_pid,
    ).toBeGreaterThan(1);
    // All these panes were allocated above by this test's fresh isolated server.
    for (const member of firstMembers) {
      await firstRunner.closePane!(member.pane_id);
      ownedClosedPanes.push(member.pane_id);
    }
    expect((await snapshot()).workspaces).toEqual([]);
    // Unrelated lane, deliberately focused. No later operation may rename,
    // move, close or split its pane merely because it has focus.
    const original = JSON.parse(
      await run(["workspace", "create", "--cwd", repoB, "--label", "Owner lane", "--focus"]),
    ).result;
    await run(["pane", "send-text", original.root_pane.pane_id, "owner unsent draft"]);
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
    const secondPane = await secondRunner.createTab!({
      cwd: worktree,
      label: "Rafa · reviewer",
      placement: "new-tab",
    });
    const afterSolo = await snapshot();
    const p1 = afterSolo.panes.find((p: any) => p.pane_id === firstPane);
    const p2 = afterSolo.panes.find((p: any) => p.pane_id === secondPane);
    expect(p1.workspace_id).toBe(p2.workspace_id);
    expect(p1.workspace_id).not.toBe(original.workspace.workspace_id);
    expect(p1.workspace_id).not.toBe(mixed.workspace.workspace_id);
    expect(p1.tab_id).not.toBe(p2.tab_id);
    // VUH-2031: a new repo workspace contains exactly the hired allocations,
    // with no idle root shell left beside them.
    expect(
      afterSolo.panes
        .filter((p: any) => p.workspace_id === p1.workspace_id)
        .map((p: any) => p.pane_id)
        .sort(),
    ).toEqual([firstPane, secondPane].sort());

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
    ).toEqual([stages[0], stages[0]]);
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
    // Closing the only hired allocation leaves no starter shell. Existing owner
    // panes, including the same-repo shell, keep their original terminal identity.
    const soloDirectory = join(root, "single-hire");
    await mkdir(soloDirectory);
    const soloPane = await runner.createTab!({
      cwd: soloDirectory,
      label: "Solo hire",
      env: { CLANKIE_FIXTURE_LAUNCH: "solo" },
    });
    // VUH-2242: the hire's process starts in its final pane, so the pane ID it
    // claims in fleet proofs is its own, and its launch environment arrived.
    await run([
      "pane",
      "send-text",
      soloPane,
      'echo "claim=$HERDR_PANE_ID launch=$CLANKIE_FIXTURE_LAUNCH holder=[$CLANKIE_RESOURCE_HOLDER] codex=[$CODEX_THREAD_ID] claude=[$CLAUDE_SESSION_ID]"',
    ]);
    await run(["pane", "send-keys", soloPane, "Enter"]);
    let soloShell = "";
    for (let i = 0; i < 100 && !/claim=\S+ launch=/u.test(soloShell); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      soloShell = await run(["pane", "read", soloPane, "--source", "recent-unwrapped", "--lines", "20"]);
    }
    expect(soloShell).toContain(`claim=${soloPane} launch=solo holder=[] codex=[] claude=[]`);
    expect(
      JSON.parse(await run(["pane", "process-info", "--pane", soloPane])).result.process_info.pane_id,
    ).toBe(soloPane);
    const soloSnapshot = await snapshot();
    const soloWorkspace = soloSnapshot.panes.find((p: any) => p.pane_id === soloPane).workspace_id;
    expect(
      soloSnapshot.panes.filter((p: any) => p.workspace_id === soloWorkspace).map((p: any) => p.pane_id),
    ).toEqual([soloPane]);
    await runner.closePane!(soloPane);
    ownedClosedPanes.push(soloPane);
    expect((await snapshot()).panes.filter((p: any) => p.workspace_id === soloWorkspace)).toEqual([]);
    // A prepared initial command starts in its new workspace's final pane, with
    // the same native terminal/process, and leaves no starter shell beside it.
    const preparedDirectory = join(root, "prepared-new-workspace");
    await mkdir(preparedDirectory);
    let originalCommand: { terminalId: string; pid: number } | undefined;
    const preparedNewRunner = createHerdrWatchRunner(undefined, run, async (input) => {
      const id = await firstNative.createCommandTab(input);
      const pane = (await snapshot()).panes.find((p: any) => p.pane_id === id);
      const info = JSON.parse(await run(["pane", "process-info", "--pane", id])).result.process_info;
      originalCommand = { terminalId: pane.terminal_id, pid: info.shell_pid };
      return id;
    });
    const preparedNewPane = await preparedNewRunner.createTab!({
      cwd: preparedDirectory,
      label: "Prepared new workspace",
      command: ["/bin/sh", "-c", "sleep 60"],
    });
    // Herdr cannot create a workspace from an initial command; the allocation
    // closes only the idle starter shell its own workspace create returned.
    const preparedWorkspace = calls.findLast((c) => c.args[0] === "workspace" && c.args[1] === "create")!;
    const starterClose = calls.findLast((c) => c.args[0] === "pane" && c.args[1] === "close")!;
    expect(starterClose.args[2]).toBe((preparedWorkspace.result as any).result.root_pane.pane_id);
    expect(calls.indexOf(starterClose)).toBeGreaterThan(calls.indexOf(preparedWorkspace));
    ownedClosedPanes.push(starterClose.args[2]!);
    const preparedSnapshot = await snapshot();
    const preparedMember = preparedSnapshot.panes.find((p: any) => p.pane_id === preparedNewPane);
    expect(
      preparedSnapshot.panes.filter((p: any) => p.workspace_id === preparedMember.workspace_id),
    ).toHaveLength(1);
    expect(preparedMember.terminal_id).toBe(originalCommand!.terminalId);
    expect(
      JSON.parse(await run(["pane", "process-info", "--pane", preparedNewPane])).result.process_info
        .shell_pid,
    ).toBe(originalCommand!.pid);
    await preparedNewRunner.closePane!(preparedNewPane);
    ownedClosedPanes.push(preparedNewPane);
    expect((await snapshot()).panes.some((p: any) => p.workspace_id === preparedMember.workspace_id)).toBe(
      false,
    );
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
      const allocations: { id: string; pid: number; terminal: string }[] = [];
      const prepared = createHerdrWatchRunner(undefined, run, async (input) => {
        const id = await native.createCommandTab(input);
        const process = JSON.parse(await run(["pane", "process-info", "--pane", id])).result.process_info;
        const pane = (await snapshot()).panes.find((p: any) => p.pane_id === id);
        allocations.push({ id, pid: process.shell_pid, terminal: pane.terminal_id });
        return id;
      });
      const pane = await prepared.createTab!({
        cwd: repoA,
        label: "Juno · tester",
        command: ["/bin/sh", "-c", "sleep 60"],
      });
      expect((await snapshot()).panes.find((p: any) => p.pane_id === pane).workspace_id).toBe(
        p1.workspace_id,
      );
      const joined = await prepared.createTab!({
        cwd: repoA,
        label: "Juno · tester",
        pipeline: pipeline.pipeline!,
        placement: "split",
        command: ["/bin/sh", "-c", "sleep 60"],
      });
      const joinedPane = (await snapshot()).panes.find((p: any) => p.pane_id === joined);
      expect(joinedPane.tab_id).toBe(stagePanes[0].tab_id);
      expect(joinedPane.terminal_id).toBe(allocations.at(-1)!.terminal);
      expect(
        JSON.parse(await run(["pane", "process-info", "--pane", joined])).result.process_info.shell_pid,
      ).toBe(allocations.at(-1)!.pid);
    }
    // Five ordinary hires fill row-major 2x2, then a named second tab, with
    // independent runner recreation and prepared native argv in the same grid.
    const grid: string[] = [];
    for (let i = 0; i < 5; i++)
      grid.push(
        await createHerdrWatchRunner(undefined, run).createTab!({
          cwd: repoA,
          label: `Grid ${i + 1}`,
          group: "VUH-1869 authors",
        }),
      );
    const gridSnapshot = await snapshot();
    const gridPanes = grid.map((id) => gridSnapshot.panes.find((p: any) => p.pane_id === id));
    expect(new Set(gridPanes.slice(0, 4).map((p: any) => p.tab_id)).size).toBe(1);
    expect(gridPanes[4].tab_id).not.toBe(gridPanes[0].tab_id);
    expect(gridSnapshot.tabs.find((t: any) => t.tab_id === gridPanes[0].tab_id).label).toBe(
      "VUH-1869 authors",
    );
    expect(gridSnapshot.tabs.find((t: any) => t.tab_id === gridPanes[4].tab_id).label).toBe(
      "VUH-1869 authors · 2",
    );
    const gridLayout = JSON.parse(await run(["pane", "layout", "--pane", grid[0]!])).result.layout;
    const rects = grid.slice(0, 4).map((id) => gridLayout.panes.find((p: any) => p.pane_id === id).rect);
    expect(rects[0].x).toBe(rects[2].x);
    expect(rects[1].x).toBe(rects[3].x);
    expect(rects[0].y).toBe(rects[1].y);
    expect(rects[2].y).toBe(rects[3].y);
    expect(rects[1].x).toBeGreaterThan(rects[0].x);
    expect(rects[2].y).toBeGreaterThan(rects[0].y);
    expect(
      Math.max(...rects.map((r: any) => r.width)) - Math.min(...rects.map((r: any) => r.width)),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.max(...rects.map((r: any) => r.height)) - Math.min(...rects.map((r: any) => r.height)),
    ).toBeLessThanOrEqual(1);
    // VUH-2190: Herdr compacts either column after any corner is closed.
    // Two subsequent real allocator calls must succeed, preserving survivors.
    const closedGridProof: unknown[] = [];
    for (let corner = 0; corner < 4; corner++) {
      const group = `VUH-2190 corner ${corner}`;
      const create = () =>
        createHerdrWatchRunner(undefined, run).createTab!({
          cwd: repoA,
          label: "Grid retry",
          group,
        });
      const allocated: string[] = [];
      for (let i = 0; i < 4; i++) allocated.push(await create());
      await runner.closePane!(allocated[corner]!);
      ownedClosedPanes.push(allocated[corner]!);
      const survivors = (await snapshot()).panes.filter((p: any) => allocated.includes(p.pane_id));
      const afterClose = JSON.parse(await run(["pane", "layout", "--pane", survivors[0].pane_id])).result
        .layout;
      const subsequent = [await create(), await create()];
      const after = await snapshot();
      expect(subsequent.every((id) => after.panes.some((p: any) => p.pane_id === id))).toBe(true);
      for (const pane of survivors) {
        const retained = after.panes.find((p: any) => p.pane_id === pane.pane_id);
        expect({ tab: retained.tab_id, terminal: retained.terminal_id }).toEqual({
          tab: pane.tab_id,
          terminal: pane.terminal_id,
        });
      }
      closedGridProof.push({ corner, closed: allocated[corner], afterClose, subsequent });
    }
    // A real foreign-tab validation refusal happens before any native effect,
    // even though the project launch fence has already been marked dispatched.
    const refusalPath = join(root, "not-started.json");
    const refusalSettings = ProjectsSettingsSchema.parse({
      projects: [{ id: "proof", name: "Proof", workerCap: 1 }],
    });
    const refusalRequest = SpawnOperatorSeatSchema.parse({
      schemaVersion: 1,
      harness: "claude",
      title: "Preallocation refusal",
      workingDirectory: repoA,
      pipeline: "Foreign workflow",
      placement: "split",
      projectId: "proof",
    });
    const beforeRefusal = (await snapshot()).panes.length;
    const refusals = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new HerdrWatchStore(refusalPath, {
        runner,
        projectHirePolicy: {
          settings: async () => refusalSettings,
          tools: async () => [],
          project: async () => "proof",
        },
      });
      try {
        const result = await store.spawnSeat(refusalRequest);
        expect(result).toMatchObject({ outcome: "failed", reason: "herdr_unreachable" });
        if (result.outcome !== "failed") throw new Error("Expected a pre-allocation refusal");
        expect(result.detail).toContain("not a verified hire grid");
        refusals.push(result);
      } finally {
        store.close();
      }
    }
    expect((await snapshot()).panes.length).toBe(beforeRefusal);
    const rejectedAllocations = JSON.parse(
      await readFile(`${refusalPath}.project-hires.json`, "utf8"),
    ).allocations;
    expect(rejectedAllocations).toHaveLength(2);
    expect(
      rejectedAllocations.every((a: any) => a.started === false && a.gone === true && a.pane === undefined),
    ).toBe(true);
    // Real transport fault after a successful mutation: preserve the uncertain
    // hire receipt across a new store instance, never start/retry a harness.
    const uncertainty: unknown[] = [];
    for (const fault of ["tab-reply", "pane-label", "workspace-create"] as const) {
      const faultCwd = fault === "workspace-create" ? join(root, "uncertain-new-workspace") : plain;
      if (fault === "workspace-create") await mkdir(faultCwd);
      let dropped = false;
      const faultRunner = createHerdrWatchRunner(undefined, async (args) => {
        const raw = await run(args);
        if (
          !dropped &&
          ((fault === "workspace-create" && args[0] === "workspace" && args[1] === "create") ||
            (fault === "tab-reply" && args[0] === "tab" && args[1] === "create") ||
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
        placement: "new-tab",
        role: "implementer",
        workingDirectory: faultCwd,
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
    expect(
      await run([
        "pane",
        "read",
        original.root_pane.pane_id,
        "--source",
        "recent-unwrapped",
        "--lines",
        "20",
      ]),
    ).toContain("owner unsent draft");
    expect(final.workspaces.find((w: any) => w.workspace_id === original.workspace.workspace_id).label).toBe(
      "Owner lane",
    );
    expect(final.panes.filter((p: any) => p.workspace_id === mixed.workspace.workspace_id)).toEqual(
      before.panes.filter((p: any) => p.workspace_id === mixed.workspace.workspace_id),
    );
    expect(final.tabs.filter((t: any) => t.workspace_id === mixed.workspace.workspace_id)).toEqual(
      before.tabs.filter((t: any) => t.workspace_id === mixed.workspace.workspace_id),
    );
    expect(calls.filter((c) => c.args.includes("close")).map((c) => c.args[2])).toEqual(ownedClosedPanes);
    expect(
      calls
        .filter((c) => c.args[0] === "pane" && c.args[1] === "move")
        .every((c) => c.args[2] !== original.root_pane.pane_id && c.args[2] !== mixed.root_pane.pane_id),
    ).toBe(true);
    if (process.env.VUH1550_EVIDENCE) {
      await writeFile(
        join(process.env.VUH1550_EVIDENCE, "herdr-layout-journey.json"),
        JSON.stringify(
          {
            session,
            before,
            closedGridProof,
            refusals,
            firstHireSnapshot,
            afterSolo,
            pipelineSnapshot,
            gridSnapshot,
            gridLayout,
            final,
            uncertainty,
            calls,
          },
          null,
          2,
        ),
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
