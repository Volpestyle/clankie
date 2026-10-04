import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ExecFileImpl } from "../src/install-doctor.ts";
import { inspectHarnessBridges } from "../src/harness-doctor.ts";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

// Herdr's host census and macOS process facts enter the actual doctor and bridge
// parser. Pane titles and bridge environment claims do not supply spawn edges.
const lead = "w3Z:pH";
const child = "w3Z:p1G";
const socket = "/test/parent-lead.sock";
const url = "http://127.0.0.1:54321";

async function observe(
  options: {
    parentHarness?: string;
    parentPresent?: boolean;
    parentBridge?: "worker" | "operator";
    parentClaim?: string;
    parentEdge?: boolean;
    processUnavailable?: boolean;
    foregroundUnavailable?: boolean;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "clankie-parent-lead-doctor-"));
  homes.push(home);
  await mkdir(join(home, ".clankie", "links"), { recursive: true });
  await writeFile(
    join(home, ".clankie", "links", "default-local.json"),
    JSON.stringify({ schemaVersion: 2, authentication: "local-process", socket, url }),
  );
  const census = {
    result: {
      agents: [
        ...(options.parentPresent === false
          ? []
          : [
              {
                pane_id: lead,
                terminal_id: "term_parent",
                ...(options.parentHarness === "unknown" ? {} : { agent: options.parentHarness ?? "claude" }),
                title: "ordinary pane",
              },
            ]),
        {
          pane_id: child,
          terminal_id: "term_child",
          agent: "codex",
          ...(options.parentEdge === false ? {} : { parent_pane_id: lead }),
          title: `Lead ${lead} worker`,
          tab_name: `launched by ${lead}`,
          name: `child of ${lead}`,
        },
      ],
    },
  };
  const processes = [
    "10 1 /bin/zsh",
    "11 1 /bin/zsh",
    "20 10 /bin/claude",
    "21 11 /bin/codex",
    ...(options.parentBridge
      ? [
          `30 20 node /release/apps/tui/bin/clankie.js mcp ${options.parentBridge === "worker" ? "--fleet" : "--lane operator"}`,
        ]
      : []),
    "31 21 node /release/apps/tui/bin/clankie.js mcp --fleet",
    "99 1 node /runtime/apps/clankie/src/index.ts",
  ].join("\n");
  const calls: { command: string; args: readonly string[] }[] = [];
  const execute: ExecFileImpl = async (command, args) => {
    calls.push({ command, args });
    if (command === "/usr/bin/env") {
      expect(args.slice(0, 2)).toEqual([`HERDR_SOCKET_PATH=${socket}`, "herdr"]);
      if (args[2] === "agent") {
        expect(args.slice(2)).toEqual(["agent", "list"]);
        return { stdout: JSON.stringify(census), stderr: "" };
      }
      const paneId = args.at(-1);
      expect(args.slice(2, 5)).toEqual(["pane", "process-info", "--pane"]);
      if (options.foregroundUnavailable && paneId === lead) throw new Error("pane probe unavailable");
      return {
        stdout: JSON.stringify({
          result: {
            process_info: {
              pane_id: paneId,
              shell_pid: paneId === lead ? 10 : 11,
              foreground_process_group_id: paneId === lead ? 20 : 21,
            },
          },
        }),
        stderr: "",
      };
    }
    if (command === "/bin/ps") {
      if (options.processUnavailable) throw new Error("process snapshot unavailable");
      const stdout = args.includes("pid=,lstart=")
        ? "30 Sun Oct  4 10:00:00 2026\n31 Sun Oct  4 12:30:00 2026\n99 Sun Oct  4 12:00:00 2026"
        : args[0] === "eww"
          ? [
              ...(options.parentBridge
                ? [
                    `30 node HERDR_PANE_ID=${options.parentClaim ?? lead} HERDR_SOCKET_PATH=${socket} SECRET=never-report-env`,
                  ]
                : []),
              `31 node HERDR_PANE_ID=${child} HERDR_SOCKET_PATH=${socket} SECRET=never-report-env`,
            ].join("\n")
          : processes;
      return { stdout, stderr: "" };
    }
    if (command === "ps") return { stdout: `${process.pid} 1 /test/doctor`, stderr: "" };
    if (args.includes("mcp"))
      return {
        stdout: JSON.stringify({
          enabled: true,
          transport: {
            command: "clankie",
            args: ["mcp", "--fleet"],
            env_vars: ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"],
          },
        }),
        stderr: "",
      };
    return { stdout: "{}", stderr: "" };
  };
  const fetched: string[] = [];
  const probe: typeof fetch = async (input, init) => {
    fetched.push(String(input));
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(init?.method ?? "GET").toBe("GET");
    return Response.json({ ok: true, service: "clankie", runtime: { pid: 99 } });
  };
  const report = await inspectHarnessBridges(
    { HOME: home, XDG_CONFIG_HOME: join(home, "config") },
    execute,
    probe,
  );
  expect(fetched).toEqual([`${url}/health`]);
  expect(report.localFleet.membership).toBe("not-in-session");
  expect(JSON.stringify(report)).not.toContain("never-report-env");
  return { report, calls };
}

const mac = it.runIf(process.platform === "darwin");

mac("names the census parent without a bridge while its worker's actual bridge is live", async () => {
  const { report } = await observe();
  expect(report.linkedSession.panes.find((pane) => pane.paneId === child)).toMatchObject({
    status: "live-process",
    bridgePid: 31,
  });
  expect(report.linkedSession.parentLeads).toEqual([
    {
      paneId: lead,
      terminalId: "term_parent",
      harness: "claude",
      children: [{ paneId: child, terminalId: "term_child" }],
      bridgeStatus: "missing",
      detail: `Lead pane ${lead} parenting ${child} has no observed Clankie bridge for its live native harness. This does not prove that its profile lacks an installation.`,
      remediation: expect.stringContaining(
        `Lead pane ${lead} parenting ${child} has no observed Clankie bridge.`,
      ),
    },
  ]);
  expect(report.remediation).toContain(report.linkedSession.parentLeads![0]!.remediation);
  expect(JSON.stringify(report.linkedSession.parentLeads)).not.toContain("conversationId");
});

mac.each(["worker", "operator"] as const)(
  "observes a parent's %s bridge and preserves the real runtime-age warning",
  async (parentBridge) => {
    const { report } = await observe({ parentBridge });
    expect(report.linkedSession.parentLeads?.[0]).toMatchObject({
      paneId: lead,
      terminalId: "term_parent",
      bridgeStatus: "live-process",
      detail: expect.stringContaining("parent report routing remain unverified"),
    });
    expect(report.linkedSession.parentLeads?.[0]?.remediation).toBeUndefined();
    const parent = report.linkedSession.panes.find((pane) => pane.paneId === lead)!;
    const bridge = parentBridge === "operator" ? parent.operatorBridge : parent;
    expect(bridge).toMatchObject({
      status: "live-process",
      bridgePid: 30,
      freshness: "older-than-runtime",
      remediation: expect.stringContaining("restart the seat"),
    });
    expect(report.remediation.some((line) => line.includes(`Lead pane ${lead}`))).toBe(false);
  },
);

mac.each(["unknown", "shell"])(
  "keeps a census parent named when its harness is %s",
  async (parentHarness) => {
    const { report, calls } = await observe({ parentHarness, parentBridge: "worker" });
    expect(report.linkedSession.parentLeads?.[0]).toMatchObject({
      paneId: lead,
      terminalId: "term_parent",
      children: [{ paneId: child, terminalId: "term_child" }],
      bridgeStatus: "unobserved",
    });
    expect(report.linkedSession.parentLeads?.[0]?.harness).toBe(
      parentHarness === "unknown" ? undefined : "shell",
    );
    expect(calls.some((call) => call.args.includes("process-info") && call.args.at(-1) === lead)).toBe(false);
    expect(report.linkedSession.unownedBridges).toContainEqual(
      expect.objectContaining({ pid: 30, claimedPane: lead }),
    );
    expect(report.remediation.some((line) => line.includes(`Lead pane ${lead} parenting ${child}`))).toBe(
      true,
    );
  },
);

mac("does not promote an absent census parent from a bridge's claimed pane", async () => {
  const { report } = await observe({ parentPresent: false, parentBridge: "worker" });
  expect(report.linkedSession.parentLeads?.[0]).toMatchObject({
    paneId: lead,
    bridgeStatus: "unobserved",
    detail: expect.stringContaining("absent from the current agent census"),
  });
  expect(report.linkedSession.parentLeads?.[0]?.terminalId).toBeUndefined();
});

mac("refuses a parent's mismatched bridge claim without borrowing its child's matching bridge", async () => {
  const { report } = await observe({ parentBridge: "worker", parentClaim: child });
  expect(report.linkedSession.parentLeads?.[0]?.bridgeStatus).toBe("pane-mismatch");
  expect(report.linkedSession.panes.find((pane) => pane.paneId === child)?.status).toBe("live-process");
  expect(report.remediation.some((line) => line.includes(`Lead pane ${lead} parenting ${child}`))).toBe(true);
});

mac.each([{ processUnavailable: true }, { foregroundUnavailable: true }])(
  "keeps an unavailable parent observation separate from a missing bridge: %j",
  async (options) => {
    const { report } = await observe(options);
    expect(report.linkedSession.parentLeads?.[0]).toMatchObject({ paneId: lead, bridgeStatus: "unobserved" });
    expect(report.linkedSession.parentLeads?.[0]?.detail).not.toContain(
      "has no observed Clankie bridge for its live native harness",
    );
  },
);

mac("never derives a parent relationship from pane names, titles or tabs", async () => {
  const { report } = await observe({ parentEdge: false, parentBridge: "worker" });
  expect(report.linkedSession.parentLeads).toEqual([]);
  expect(report.remediation.some((line) => line.includes(`Lead pane ${lead}`))).toBe(false);
});
