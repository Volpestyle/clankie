import { expect, it } from "vitest";
import { createProjectProcessObserver } from "../src/project-process-proof.ts";

function fixture() {
  const state = {
    shell: 30,
    agent: 40,
    command: "/usr/local/bin/codex",
    binding: "/host/socket",
    start: "Sat Oct  3 10:00:00 2026",
    calls: 0,
    change: "",
    native: "session",
    harness: "codex",
    mapped: "/trusted/codex",
    argv: "",
  };
  const observe = createProjectProcessObserver({
    platform: "darwin",
    launcher: async (harness) =>
      harness === "pi"
        ? { executable: "/trusted/node", script: "/trusted/pi/cli.js" }
        : { executable: `/trusted/${harness}` },
    canonical: async (path) => path,
    herdrBinary: "herdr",
    binding: async () => ({ runtime: "external", socketPath: state.binding, session: "default" }),
    run: async (command, args) => {
      if (command === "herdr" && args[0] === "agent") {
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
      if (command === "/usr/sbin/lsof") return `p${state.agent}\nftxt\nn${state.mapped}\n`;
      if (command === "/bin/ps" && args.at(-1) === "command=") return state.argv;
      if (command === "/bin/ps") {
        const pid = Number(args[1]);
        if (state.change === "process" && ++state.calls > 2) state.start = "Sat Oct  3 10:00:01 2026";
        return `${state.start} ${pid === state.shell ? "/bin/zsh" : state.command}\n`;
      }
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
  return { state, observe };
}
it("captures the actual native foreground process and shell lifetimes", async () => {
  const f = fixture();
  expect(await f.observe("default", "w1:p1")).toMatchObject({
    fleet: "default",
    processes: [{ pid: 40, startTime: f.state.start }],
    shell: { pid: 30 },
  });
});
it("proves a hand-started native process before Herdr reports its session", async () => {
  const f = fixture();
  f.state.native = "";
  const pending = await f.observe("default", "w1:p1");
  expect(pending).toMatchObject({
    nativeSessionPending: true,
    nativeOccupantId: expect.stringMatching(/^process-/u),
    processes: [{ pid: 40, startTime: f.state.start }],
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
  },
);
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
