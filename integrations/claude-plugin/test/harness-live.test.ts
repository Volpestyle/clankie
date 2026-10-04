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
  runtimePid?: number;
  starts?: string;
  startUnavailable?: boolean;
}) {
  const calls: [string, string[]][] = [];
  const promise = inspectLiveHarnessBridges({
    socket,
    panes: [pane],
    platform: options.platform ?? "darwin",
    ...(options.runtimePid === undefined ? {} : { runtimePid: options.runtimePid }),
    run: async (command, args) => {
      calls.push([command, args]);
      if (options.unavailable) throw new Error("denied");
      if (command === "/bin/ps") {
        if (args.includes("pid=,lstart=")) {
          if (options.startUnavailable) throw new Error("process clock denied");
          return options.starts ?? "";
        }
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

it("flags a worker older than the live runtime while retaining its proven transport membership", async () => {
  const report = await observer({
    rows: `${cli}\n${bridge}\n99 1 node /runtime/apps/clankie/src/index.ts`,
    env: env(),
    runtimePid: 99,
    starts: "30 Sat Oct  3 12:00:00 2026\n99 Sun Oct  4 12:00:00 2026",
  }).promise;
  expect(report.panes[0]).toMatchObject({
    status: "live-process",
    freshness: "older-than-runtime",
    remediation: expect.stringContaining("restart the seat"),
    bridgeStartedAt: expect.any(String),
    runtimeStartedAt: expect.any(String),
  });
  expect(report.panes[0]?.remediation).toContain("age alone does not prove an obsolete build");
});

it("reports an old operator bridge independently without counting it as a live worker bridge", async () => {
  const report = await observer({
    rows: `${cli}\n30 20 node /home/.local/bin/clankie mcp --lane operator --conversation global-default\n99 1 node /runtime/apps/clankie/src/index.ts`,
    env: env(),
    runtimePid: 99,
    starts: "30 Sat Oct  3 12:00:00 2026\n99 Sun Oct  4 12:00:00 2026",
  }).promise;
  expect(report.panes[0]).toMatchObject({
    status: "missing",
    operatorBridge: {
      status: "live-process",
      freshness: "older-than-runtime",
      bridgePid: 30,
      remediation: expect.stringContaining("restart the seat"),
    },
  });
  expect(report.unownedBridges).toEqual([]);
  expect(JSON.stringify(report)).not.toMatch(/do-not-print|not-public/);
});

it("keeps worker and operator ages independent and treats equal starts as current", async () => {
  const report = await observer({
    rows: `${cli}\n${bridge}\n31 20 node /home/.local/bin/clankie mcp\n99 1 node /runtime/apps/clankie/src/index.ts`,
    env: `${env()}\n31 node clankie mcp HERDR_PANE_ID=${pane.paneId} HERDR_SOCKET_PATH=${socket}`,
    runtimePid: 99,
    starts: "30 Sun Oct  4 12:00:00 2026\n31 Sat Oct  3 12:00:00 2026\n99 Sun Oct  4 12:00:00 2026",
  }).promise;
  expect(report.panes[0]).toMatchObject({
    status: "live-process",
    freshness: "current",
    operatorBridge: { status: "live-process", freshness: "older-than-runtime" },
  });
  expect(report.panes[0]?.remediation).toBeUndefined();
});

it.each(["--fleet", "--lane operator"])(
  "observes the packaged node clankie.js launcher with %s independently of its role",
  async (args) => {
    const report = await observer({
      rows: `${cli}\n30 20 /release/libexec/node /release/apps/tui/bin/clankie.js mcp ${args}\n99 1 node /runtime/apps/clankie/src/index.ts`,
      env: env(),
      runtimePid: 99,
      starts: "30 Sat Oct  3 12:00:00 2026\n99 Sun Oct  4 12:00:00 2026",
    }).promise;
    const observation = report.panes[0];
    const process = args === "--fleet" ? observation : observation?.operatorBridge;
    expect(process).toMatchObject({
      status: "live-process",
      bridgePid: 30,
      freshness: "older-than-runtime",
      remediation: expect.stringContaining("restart the seat"),
    });
    expect(observation?.status).toBe(args === "--fleet" ? "live-process" : "missing");
    expect(report.unownedBridges).toEqual([]);
  },
);

it("excludes seat/grant bridges and unrelated packaged script or shell mentions", async () => {
  const report = await observer({
    rows: `${cli}\n30 20 node /release/apps/tui/bin/clankie.js mcp --seat\n31 20 node /release/apps/tui/bin/clankie.js mcp --grant fixture\n32 20 node /release/apps/tui/bin/clankie-helper.js mcp --fleet\n33 20 /bin/zsh -c 'node /release/apps/tui/bin/clankie.js mcp --lane operator'`,
    env: [30, 31, 32, 33]
      .map((pid) => `${pid} node HERDR_PANE_ID=${pane.paneId} HERDR_SOCKET_PATH=${socket}`)
      .join("\n"),
  }).promise;
  expect(report.panes[0]).toMatchObject({ status: "missing" });
  expect(report.panes[0]?.operatorBridge).toBeUndefined();
  expect(report.unownedBridges).toEqual([]);
});

const beforeRuntime = "Sat Oct  3 12:00:00 2026";
const withRuntime = "Sun Oct  4 12:00:00 2026";
const afterRuntime = "Mon Oct  5 12:00:00 2026";
it.each([
  { worker: beforeRuntime, operator: afterRuntime, workerAge: "older-than-runtime", operatorAge: "current" },
  { worker: afterRuntime, operator: beforeRuntime, workerAge: "current", operatorAge: "older-than-runtime" },
  { worker: withRuntime, operator: withRuntime, workerAge: "current", operatorAge: "current" },
  { worker: undefined, operator: afterRuntime, workerAge: "unknown", operatorAge: "current" },
  { worker: afterRuntime, operator: undefined, workerAge: "current", operatorAge: "unknown" },
  { worker: undefined, operator: undefined, workerAge: "unknown", operatorAge: "unknown" },
])("compares each bridge's own start with the running service: $workerAge / $operatorAge", async (fact) => {
  const report = await observer({
    rows: `${cli}\n${bridge}\n31 20 node /home/.local/bin/clankie mcp --lane operator\n99 1 node /runtime/apps/clankie/src/index.ts`,
    env: `${env()}\n31 node clankie mcp HERDR_PANE_ID=${pane.paneId} HERDR_SOCKET_PATH=${socket}`,
    runtimePid: 99,
    starts: [
      ...(fact.worker ? [`30 ${fact.worker}`] : []),
      ...(fact.operator ? [`31 ${fact.operator}`] : []),
      `99 ${withRuntime}`,
    ].join("\n"),
  }).promise;
  const worker = report.panes[0];
  const operator = worker?.operatorBridge;
  expect(worker).toMatchObject({ status: "live-process", freshness: fact.workerAge });
  expect(operator).toMatchObject({ status: "live-process", freshness: fact.operatorAge });
  for (const [observation, expected] of [
    [worker, fact.workerAge],
    [operator, fact.operatorAge],
  ] as const) {
    if (expected === "older-than-runtime") expect(observation?.remediation).toContain("restart the seat");
    else expect(observation?.remediation).toBeUndefined();
  }
});

it("never marks a bridge stale when runtime identity or start clocks are unavailable", async () => {
  for (const fact of [
    { starts: "30 invalid\n99 Sun Oct  4 12:00:00 2026" },
    { starts: "30 Sat Oct  3 12:00:00 2026" },
    { startUnavailable: true },
  ]) {
    const report = await observer({
      rows: `${cli}\n${bridge}\n99 1 node /runtime/apps/clankie/src/index.ts`,
      env: env(),
      runtimePid: 99,
      ...fact,
    }).promise;
    expect(report.panes[0]).toMatchObject({ status: "live-process", freshness: "unknown" });
    expect(report.panes[0]?.remediation).toBeUndefined();
  }
  const report = await observer({ rows: `${cli}\n${bridge}`, env: env(), runtimePid: 99 }).promise;
  expect(report.panes[0]).toMatchObject({ status: "live-process", freshness: "unknown" });
});

it("does not accept an operator's missing pane/socket environment as observed membership", async () => {
  const report = await observer({ rows: `${cli}\n30 20 node /home/.local/bin/clankie mcp --lane operator` })
    .promise;
  expect(report.panes[0]).toMatchObject({ status: "missing", operatorBridge: { status: "unobserved" } });
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
