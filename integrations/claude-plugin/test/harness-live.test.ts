import { expect, it } from "vitest";
import { inspectLiveHarnessBridges } from "../worker/bin/harness-live.mjs";

const socket = "/tmp/linked.sock";
const pane = { paneId: "w1:p2", harness: "codex" };
function observer(options: {
  rows: string;
  env?: string;
  pid?: number;
  unavailable?: boolean;
  platform?: string;
}) {
  const calls: [string, string[]][] = [];
  const promise = inspectLiveHarnessBridges({
    socket,
    panes: [pane],
    platform: options.platform ?? "darwin",
    run: async (command, args) => {
      calls.push([command, args]);
      if (options.unavailable) throw new Error("denied");
      if (command === "/bin/ps") {
        if (args[0] === "eww") return options.env ?? "";
        if (args[0] === "-axo")
          return options.rows
            .split("\n")
            .map((row) => row.split(" ").slice(0, 3).join(" "))
            .join("\n");
        return options.rows;
      }
      return JSON.stringify({
        result: {
          process_info: {
            pane_id: pane.paneId,
            shell_pid: 10,
            foreground_process_group_id: options.pid ?? 20,
          },
        },
      });
    },
  });
  return { promise, calls };
}
const cli = "20 10 /bin/codex";
const bridge = "30 20 node /home/.local/bin/clankie mcp --fleet";
const env = (claim = pane.paneId, sock = socket) =>
  `30 node clankie mcp --fleet SECRET=do-not-print HERDR_PANE_ID=${claim} HERDR_SOCKET_PATH=${sock} OTHER=not-public`;

it("joins ancestry and allowlisted env, never copying secrets or counting command mentions", async () => {
  const { promise, calls } = observer({
    rows: `${cli}\n${bridge}\n40 20 /bin/zsh -c 'clankie mcp --fleet'`,
    env: env(),
  });
  const report = await promise;
  expect(report.panes[0]).toMatchObject({ status: "live-process", bridgePid: 30, claimedPane: "w1:p2" });
  expect(calls).toHaveLength(4);
  expect(calls[2]![1]).toContain("30");
  expect(JSON.stringify(report)).not.toMatch(/do-not-print|not-public/);
});
it("flags a wrong pane or socket rather than accepting its environment claim", async () => {
  for (const observation of [env("w1:p1"), env(pane.paneId, "/another.sock")]) {
    const report = await observer({ rows: `${cli}\n${bridge}`, env: observation }).promise;
    expect(report.panes[0]?.remediation).not.toContain("daemon stop");
    expect(report.panes[0]).toMatchObject({
      status: "pane-mismatch",
      remediation: expect.stringContaining("codex --no-daemon resume"),
    });
  }
});
it("reports missing Claude bridges with the profile/plugin fix", async () => {
  const report = await inspectLiveHarnessBridges({
    socket,
    platform: "darwin",
    panes: [{ ...pane, harness: "claude" }],
    run: async (command) =>
      command === "/bin/ps"
        ? "20 10 /bin/claude"
        : JSON.stringify({
            result: {
              process_info: { pane_id: pane.paneId, shell_pid: 10, foreground_process_group_id: 20 },
            },
          }),
  });
  expect(report.panes[0]).toMatchObject({
    status: "missing",
    remediation: expect.stringContaining("claude plugin enable clankie-worker@clankie"),
  });
});
it("joins hired dedicated servers by the exact remote/listen socket, not claimed pane or shell", async () => {
  const report = await observer({
    rows: `${cli} --remote unix:///private/rpc.sock\n25 1 codex app-server --listen unix:///private/rpc.sock\n30 25 node /home/.local/bin/clankie mcp --fleet`,
    env: env(),
  }).promise;
  expect(report.panes[0]?.status).toBe("live-process");
  const wrong = await observer({
    rows: `${cli} --remote unix:///different/rpc.sock\n25 1 codex app-server --listen unix:///private/rpc.sock\n30 25 node /home/.local/bin/clankie mcp --fleet`,
    env: env(),
  }).promise;
  expect(wrong.panes[0]?.status).toBe("missing");
});
it("surfaces shared-daemon inherited claims without assigning unrelated panes to it", async () => {
  const report = await observer({
    rows: `${cli}\n25 1 /home/.codex/app-server-daemon/releases/codex app-server\n30 25 node /home/.local/bin/clankie mcp --fleet`,
    env: env("w1:p1"),
  }).promise;
  expect(report.unownedBridges[0]).toMatchObject({
    pid: 30,
    claimedPane: "w1:p1",
    sharedDaemon: true,
    remediation: expect.stringContaining("codex app-server daemon stop"),
  });
  expect(report.panes[0]).toMatchObject({
    status: "missing",
    detail: expect.stringContaining("ownership remains unproven"),
    remediation: expect.stringContaining("codex app-server daemon stop"),
  });
});
it("does not turn denied env, absent foreground, unsupported hosts, or snapshot failure into missing", async () => {
  expect((await observer({ rows: `${cli}\n${bridge}` }).promise).panes[0]?.status).toBe("unobserved");
  expect((await observer({ rows: cli, pid: 10 }).promise).panes[0]?.status).toBe("unobserved");
  expect((await observer({ rows: cli, unavailable: true }).promise).state).toBe("unavailable");
  expect((await observer({ rows: cli, platform: "win32" }).promise).state).toBe("unsupported");
});
it("recognizes the actual installed Claude worker bridge and excludes unrelated swarm MCPs", async () => {
  const report = await inspectLiveHarnessBridges({
    socket,
    platform: "darwin",
    panes: [{ ...pane, harness: "claude" }],
    run: async (command, args) =>
      command === "/bin/ps"
        ? args[0] !== "eww"
          ? "20 10 /bin/claude\n30 20 node /home/.claude/plugins/cache/clankie/clankie-worker/0.6.1/bin/swarm-mcp.mjs\n40 20 node /dev/swarm-mcp/dist/server.mjs"
          : env()
        : JSON.stringify({
            result: {
              process_info: { pane_id: pane.paneId, shell_pid: 10, foreground_process_group_id: 20 },
            },
          }),
  });
  expect(report.panes[0]?.status).toBe("live-process");
});

it("uses the native member of a wrapper's foreground process group", async () => {
  const report = await inspectLiveHarnessBridges({
    socket,
    platform: "darwin",
    panes: [{ ...pane, harness: "claude" }],
    run: async (command, args) => {
      if (command === "/bin/ps")
        return args[0] === "eww"
          ? env()
          : "20 10 /bin/python\n21 20 /home/.local/bin/claude\n30 21 node /home/.claude/plugins/cache/clankie/clankie-worker/0.6.1/bin/swarm-mcp.mjs";
      return JSON.stringify({
        result: {
          process_info: {
            pane_id: pane.paneId,
            shell_pid: 10,
            foreground_process_group_id: 20,
            foreground_processes: [
              { pid: 20, argv: ["python", "wrapper.py"] },
              { pid: 21, argv: ["/home/.local/bin/claude"] },
            ],
          },
        },
      });
    },
  });
  expect(report.panes[0]?.status).toBe("live-process");
});
