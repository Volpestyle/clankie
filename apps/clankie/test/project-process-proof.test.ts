import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectProcessObserver,
  harnessReleaseSibling,
  HarnessBinaryObservations,
  type ProjectProcessRefusal,
} from "../src/project-process-proof.ts";
import { projectProcessFixture, processFixtureStart } from "./helpers/local-fleet-process.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function fixture(report?: (event: ProjectProcessRefusal) => void) {
  const refusals: ProjectProcessRefusal[] = [];
  let processReads = 0;
  let nativeReads = 0;
  const state = {
    shell: 30,
    agent: 40 as number | undefined,
    command: "/usr/local/bin/codex",
    binding: "/host/socket",
    start: "Sat Oct  3 10:00:00 2026",
    calls: 0,
    change: "",
    native: "session",
    harness: "codex",
    mapped: "/trusted/codex",
    argv: "",
    hasBinding: true,
    hasLauncher: true,
    unavailableProcess: "",
  };
  const observe = createProjectProcessObserver({
    platform: "darwin",
    refusal: (event) => {
      refusals.push(event);
      report?.(event);
    },
    launcher: async (harness) => {
      if (state.change === "launcher-error") throw Error("private installation path");
      return !state.hasLauncher
        ? undefined
        : harness === "pi"
          ? { executable: "/trusted/node", script: "/trusted/pi/cli.js" }
          : { executable: `/trusted/${harness}` };
    },
    canonical: async (path) => path,
    herdrBinary: "herdr",
    binding: async () =>
      state.hasBinding ? { runtime: "external", socketPath: state.binding, session: "default" } : undefined,
    run: async (command, args) => {
      if (command === "herdr" && args[0] === "agent") {
        nativeReads++;
        if (state.change === "transport") throw Error("private transport address");
        if (state.change === "malformed-native")
          return JSON.stringify({ result: { agent: { agent: state.harness } } });
        if (state.change === "final-native-malformed" && nativeReads > 1) return "{";
        if (state.change === "session" && ++state.calls > 1) state.native = "replacement";
        return JSON.stringify({
          result: {
            agent: {
              pane_id: args.at(-1),
              terminal_id: "terminal",
              agent: state.harness,
              ...(state.native
                ? { agent_session: { source: state.harness, kind: "id", value: state.native } }
                : {}),
            },
          },
        });
      }
      if (args[0] === "--processes") {
        processReads++;
        if (state.unavailableProcess === (processReads === 1 ? "initial" : "final")) return "{}";
        if (state.change === "process" && ++state.calls > 1) state.start = "Sat Oct  3 10:00:01 2026";
        return projectProcessFixture(Number(args[1]), Number(args[2]), {
          start: state.start,
          executable: state.mapped,
          argv: state.argv ? state.argv.split(/\s+/u).slice(0, 2) : [],
        });
      }
      if (command !== "herdr") throw new Error("Legacy OS process commands forbidden");
      if (state.change === "pane" && ++state.calls > 1) state.agent = 99;
      if (state.change === "binding" && ++state.calls > 1) state.binding = "/other/socket";
      return JSON.stringify({
        result: {
          process_info: {
            pane_id: args.at(-1),
            shell_pid: state.shell,
            foreground_process_group_id: state.agent,
          },
        },
      });
    },
  });
  return { state, observe, refusals };
}
it("captures the actual native foreground process and shell lifetimes", async () => {
  const f = fixture();
  expect(await f.observe("default", "w1:p1")).toMatchObject({
    fleet: "default",
    processes: [{ pid: 40, startTime: processFixtureStart(f.state.start) }],
    shell: { pid: 30 },
  });
  expect(f.refusals).toEqual([]);
});
it("proves a hand-started native process before Herdr reports its session", async () => {
  const f = fixture();
  f.state.native = "";
  const pending = await f.observe("default", "w1:p1");
  expect(pending).toMatchObject({
    nativeSessionPending: true,
    nativeOccupantId: expect.stringMatching(/^process-/u),
    processes: [{ pid: 40, startTime: processFixtureStart(f.state.start) }],
    shell: { pid: 30 },
  });
  f.state.native = "session";
  const reported = await f.observe("default", "w1:p1");
  expect(reported?.nativeSessionPending).toBeUndefined();
  expect(reported?.nativeOccupantId).toMatch(/^session-/u);
});
it("still denies an uninstalled executable before session reporting", async () => {
  const f = fixture();
  f.state.native = "";
  f.state.mapped = "/untrusted/codex";
  expect(await f.observe("default", "w1:p1")).toBeUndefined();
});
it("denies a session that appears during the same proof", async () => {
  const f = fixture();
  f.state.native = "";
  f.state.change = "session";
  expect(await f.observe("default", "w1:p1")).toBeUndefined();
});
it.each(["process", "pane", "binding", "session"])(
  "denies a changed %s during observation",
  async (change) => {
    const f = fixture();
    f.state.change = change;
    expect(await f.observe("default", "w1:p1")).toBeUndefined();
    expect(f.refusals).toEqual([
      {
        reason: change === "pane" ? "process_changed" : `${change}_changed`,
        checkpoint: {
          process: "final_process",
          pane: "final_pane",
          binding: "final_binding",
          session: "final_native",
        }[change],
      },
    ]);
  },
);

it.each([
  ["binding", "binding_unavailable", "binding"],
  ["harness", "native_harness_unavailable", "initial_native"],
  ["launcher", "launcher_unavailable", "launcher"],
  ["foreground-missing", "foreground_missing", "initial_pane"],
  ["foreground-invalid", "foreground_invalid", "initial_pane"],
  ["initial", "native_initial_unavailable", "initial_process"],
  ["final", "native_final_unavailable", "final_process"],
  ["launcher-mismatch", "launcher_mismatch", "initial_process"],
  ["malformed-native", "malformed_observation", "initial_native"],
  ["final-native-malformed", "malformed_observation", "final_native"],
  ["transport", "transport_failure", "initial_native"],
  ["launcher-error", "observation_failure", "launcher"],
])(
  "reports the fixed %s refusal without leaking observation details",
  async (scenario, reason, checkpoint) => {
    const f = fixture();
    if (scenario === "binding") f.state.hasBinding = false;
    else if (scenario === "harness") f.state.harness = "unknown";
    else if (scenario === "launcher") f.state.hasLauncher = false;
    else if (scenario === "foreground-missing") f.state.agent = undefined;
    else if (scenario === "foreground-invalid") f.state.agent = f.state.shell;
    else if (scenario === "initial" || scenario === "final") f.state.unavailableProcess = scenario;
    else if (scenario === "launcher-mismatch") f.state.mapped = "/untrusted/codex";
    else f.state.change = scenario;
    expect(await f.observe("default", "w1:p1")).toBeUndefined();
    expect(f.refusals).toEqual([{ reason, checkpoint }]);
  },
);

it.each([
  ["pane_not_found", "pane_unavailable"],
  ["permission_denied", "transport_failure"],
])("classifies the real native %s response without copying upstream text", async (code, reason) => {
  const dir = await mkdtemp(join(tmpdir(), "pane-not-found-"));
  const socketPath = join(dir, "herdr.sock");
  const server = createServer((socket) => {
    let frame = "";
    socket.on("data", (data) => {
      frame += data.toString();
      if (!frame.includes("\n")) return;
      const request = JSON.parse(frame);
      socket.end(
        `${JSON.stringify({ id: request.id, error: { code, message: "private upstream text" } })}\n`,
      );
    });
  });
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const refusals: ProjectProcessRefusal[] = [];
  const observe = createProjectProcessObserver({
    platform: "darwin",
    herdrBinary: "herdr",
    binding: async () => ({ runtime: "external", socketPath, session: "default" }),
    refusal: (event) => {
      refusals.push(event);
    },
  });
  expect(await observe("default", "w1:p1")).toBeUndefined();
  expect(refusals).toEqual([{ reason, checkpoint: "initial_native" }]);
});

it("keeps refusing when the diagnostic observer throws", async () => {
  const f = fixture(() => {
    throw Error("diagnostic unavailable");
  });
  f.state.mapped = "/untrusted/codex";
  expect(await f.observe("default", "w1:p1")).toBeUndefined();
  expect(f.refusals).toEqual([{ reason: "launcher_mismatch", checkpoint: "initial_process" }]);
});
it("denies wrappers, shells, remote fleets and malformed pane claims", async () => {
  const f = fixture();
  for (const name of ["/bin/zsh", "/bin/bash", "/usr/bin/node", "/usr/bin/sleep"]) {
    f.state.command = name;
    f.state.mapped = name;
    expect(await f.observe("default", "w1:p1")).toBeUndefined();
  }
  f.state.command = "/usr/local/bin/claude";
  expect(await f.observe("pc", "w1:p1")).toBeUndefined();
  expect(await f.observe("default", "../w1:p1")).toBeUndefined();
  f.state.agent = f.state.shell;
  expect(await f.observe("default", "w1:p1")).toBeUndefined();
});

it("supports native OpenCode with the same complete OS and native-session proof", async () => {
  const f = fixture();
  f.state.harness = "opencode";
  f.state.mapped = "/trusted/opencode";
  f.state.command = "/opt/bin/opencode";
  expect(await f.observe("default", "w1:p1")).toMatchObject({ processes: [{ pid: 40 }] });
  f.state.command = "/opt/bin/codex";
  f.state.mapped = "/renamed/opencode";
  expect(await f.observe("default", "w1:p1")).toBeUndefined();
});

it("requires the real installed executable mapping even when the process name matches", async () => {
  const f = fixture();
  f.state.mapped = "/renamed/codex";
  expect(await f.observe("default", "w1:p1")).toBeUndefined();
});
it("supports a trusted Node launcher only with its installed script as the first argument", async () => {
  const f = fixture();
  f.state.harness = "pi";
  f.state.mapped = "/trusted/node";
  f.state.argv = "/trusted/node /trusted/pi/cli.js --resume";
  expect(await f.observe("default", "w1:p1")).toBeDefined();
  for (const argv of ["/trusted/node -e /trusted/pi/cli.js", "/trusted/node /untrusted/cli.js", "pi"]) {
    f.state.argv = argv;
    expect(await f.observe("default", "w1:p1")).toBeUndefined();
  }
});

describe("a seat left on a superseded harness release", () => {
  /** Real install tree: the launcher symlink moves to the new release, like a harness auto-update. */
  async function install() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "harness-releases-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const release = async (name: string) => {
      const path = join(root, ".codex/packages/standalone/releases", name, "bin/codex");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "binary");
      return path;
    };
    const previous = await release("0.160.0-aarch64-apple-darwin");
    const current = await release("0.160.1-aarch64-apple-darwin");
    const launcher = join(root, "bin/codex");
    await mkdir(dirname(launcher), { recursive: true });
    await symlink(current, launcher);
    return { root, previous, current, launcher, release };
  }
  function observer(launcher: string, executable: () => string, seen: unknown[]) {
    return createProjectProcessObserver({
      platform: "darwin",
      launcher: async () => ({ executable: await realpath(launcher) }),
      herdrBinary: "herdr",
      binding: async () => ({ runtime: "external", socketPath: "/host/socket", session: "default" }),
      harnessBinary: (pane, occupantId, update) => seen.push({ pane, occupantId, update }),
      run: async (command, args) => {
        if (command === "herdr" && args[0] === "agent")
          return JSON.stringify({
            result: {
              agent: {
                pane_id: args.at(-1),
                terminal_id: "terminal",
                agent: "codex",
                agent_session: { source: "codex", kind: "id", value: "thread" },
              },
            },
          });
        if (args[0] === "--processes")
          return projectProcessFixture(Number(args[1]), Number(args[2]), {
            start: "Sat Oct  3 10:00:00 2026",
            executable: executable(),
            argv: [],
          });
        return JSON.stringify({
          result: { process_info: { pane_id: args.at(-1), shell_pid: 30, foreground_process_group_id: 40 } },
        });
      },
    });
  }

  it("keeps proving the same seat across a routine update and reports the stale release", async () => {
    const tree = await install();
    const seen: unknown[] = [];
    let running = tree.current;
    const observe = observer(tree.launcher, () => running, seen);
    const before = await observe("default", "w1:p1");
    expect(before).toBeDefined();
    // The seat started on 0.160.0; the launcher has since moved to 0.160.1.
    running = tree.previous;
    const after = await observe("default", "w1:p1");
    expect(after).toEqual(before);
    expect(seen.at(-1)).toEqual({
      pane: "w1:p1",
      occupantId: after!.nativeOccupantId,
      update: { harness: "codex", running: "0.160.0", installed: "0.160.1" },
    });
    // The updater pruned the old release: the kernel path still identifies it.
    await rm(dirname(dirname(tree.previous)), { recursive: true });
    expect(await observe("default", "w1:p1")).toEqual(before);
    const observations = new HarnessBinaryObservations();
    observations.record("w1:p1", "thread", { harness: "codex", running: "0.160.0", installed: "0.160.1" });
    expect(observations.status("w1:p1")?.update.running).toBe("0.160.0");
    observations.record("w1:p1", "thread", undefined);
    expect(observations.status("w1:p1")).toBeUndefined();
  });

  it("still refuses executables that are not a release of the installed harness", async () => {
    const tree = await install();
    const impostors = [
      // Same version shape, different platform build or file name.
      await tree.release("0.160.0-x86_64-apple-darwin"),
      join(tree.root, ".codex/packages/standalone/releases/0.160.0-aarch64-apple-darwin/bin/codex-helper"),
      // Not a version directory, or a different install root.
      await tree.release("evil-aarch64-apple-darwin"),
      join(tree.root, ".other/packages/standalone/releases/0.160.0-aarch64-apple-darwin/bin/codex"),
      "/bin/zsh",
      "/usr/bin/node",
    ];
    for (const impostor of impostors) {
      const seen: unknown[] = [];
      expect(await observer(tree.launcher, () => impostor, seen)("default", "w1:p1")).toBeUndefined();
      expect(seen).toEqual([]);
    }
  });
});

it("matches only one version-named path segment with the same suffix", () => {
  expect(
    harnessReleaseSibling(
      "/Users/a/.local/share/claude/versions/2.1.3",
      "/Users/a/.local/share/claude/versions/2.1.2",
    ),
  ).toEqual({ installed: "2.1.3", running: "2.1.2" });
  for (const running of [
    "/Users/a/.local/share/claude/versions/2.1.3/../../evil",
    "/Users/a/.local/share/other/versions/2.1.2",
    "/Users/a/.local/share/claude/versions/2.1.2-beta",
    "relative/claude/versions/2.1.2",
  ])
    expect(harnessReleaseSibling("/Users/a/.local/share/claude/versions/2.1.3", running)).toBeUndefined();
  expect(harnessReleaseSibling("/opt/1.0.0", "/opt/1.0.1")).toBeUndefined();
});
