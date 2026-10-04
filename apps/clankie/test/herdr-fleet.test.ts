import type { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import {
  assertRemoteHerdrArgs,
  createHerdrFleetRun,
  remoteHerdrCommand,
  sshArgs,
  windowsArgument,
  type HerdrFleet,
  type HerdrFleetRun,
} from "../src/herdr-fleet.ts";
import { createRemoteHerdrRunner, routeHerdrFleets } from "../src/captain/herdr-fleet-runner.ts";
import {
  HerdrWatchStore,
  HerdrAgentResponseError,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";
import { readFleet, readHerdrSessionCensus } from "../src/captain/herdr-census.ts";
import { ExecutionConnections } from "../src/herdr-session.ts";
import { herdrFleetRuntimeArgs } from "../../tui/src/command/herdr.ts";

const pc: HerdrFleet = {
  id: "pc",
  session: "default",
  ssh: { host: "volpe@supedupsilly", shell: "powershell" },
};
const box: HerdrFleet = { id: "box", session: "work", ssh: { host: "box", shell: "posix" } };

/** `CommandLineToArgvW`'s rules, which Rust's std uses to read a Windows command line. */
function parseWindowsCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === "\\") {
      let count = 0;
      while (line[index] === "\\") {
        count += 1;
        index += 1;
      }
      if (line[index] === '"') {
        current += "\\".repeat(Math.floor(count / 2));
        if (count % 2 === 1) current += '"';
        else quoted = !quoted;
        started = true;
      } else {
        current += "\\".repeat(count);
        index -= 1;
        started = true;
      }
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (/\s/u.test(character) && !quoted) {
      if (started) args.push(current);
      current = "";
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (started) args.push(current);
  return args;
}

function decodePowerShellArgv(command: string): string[] {
  const encoded = /-EncodedCommand (\S+)$/u.exec(command)?.[1];
  const script = Buffer.from(encoded!, "base64").toString("utf16le");
  const line = /FromBase64String\('([^']+)'\)/u.exec(script)?.[1];
  return parseWindowsCommandLine(Buffer.from(line!, "base64").toString("utf8"));
}

function pane(paneId: string, terminalId: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    pane_id: paneId,
    terminal_id: terminalId,
    agent: "claude",
    agent_status: status,
    terminal_title_stripped: "Rivals lead",
    agent_session: { source: "herdr:claude", kind: "id", value: `session-${terminalId}` },
    ...extra,
  };
}

describe("remote Herdr transport", () => {
  it("only admits read and pane verbs, so no call can start, stop or replace the remote server", () => {
    for (const allowed of [
      ["agent", "list"],
      ["agent", "read", "w2:p1", "--source", "visible"],
      ["pane", "send-text", "w2:p1", "hi"],
      ["api", "snapshot"],
      ["session", "list", "--json"],
    ])
      expect(() => assertRemoteHerdrArgs(allowed)).not.toThrow();
    for (const refused of [
      [],
      ["server", "stop"],
      ["session", "attach", "default"],
      ["session", "stop", "default"],
      ["update"],
      ["machine", "add", "x"],
      ["--remote", "pc"],
      ["agent", "list", "a\0b"],
    ])
      expect(() => assertRemoteHerdrArgs(refused)).toThrow();
  });

  it("names the session on every posix call, quoted as one argv", () => {
    expect(remoteHerdrCommand(box, ["pane", "send-text", "w1:p2", "it's $HOME; rm -rf /"])).toBe(
      "exec herdr '--session' 'work' 'pane' 'send-text' 'w1:p2' 'it'\\''s $HOME; rm -rf /'",
    );
  });

  it("hands Windows herdr the exact argv, whatever quotes, backslashes and non-ASCII it carries", () => {
    const text = 'say "hi" to C:\\Users\\volpe\\ and \\"escaped\\" — ✳ done\\';
    const argv = decodePowerShellArgv(remoteHerdrCommand(pc, ["pane", "send-text", "w2:p1J", text]));
    expect(argv).toEqual(["--session", "default", "pane", "send-text", "w2:p1J", text]);
    for (const value of ["", " ", '"', "\\", 'a\\\\"b', "trailing\\\\", "tab\there"])
      expect(parseWindowsCommandLine(windowsArgument(value))).toEqual([value]);
  });

  it("carries every call over one multiplexed ssh connection with the owner's own keys", () => {
    const args = sshArgs(pc, "/Users/me/.clankie/ssh", "cmd");
    expect(args).toEqual(
      expect.arrayContaining([
        "BatchMode=yes",
        "ControlMaster=auto",
        "ControlPath=/Users/me/.clankie/ssh/%C",
        "ControlPersist=600",
      ]),
    );
    expect(args.slice(-3)).toEqual(["--", "volpe@supedupsilly", "cmd"]);
  });

  it("reports Herdr's own JSON error and a dead link as distinct failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-fleet-"));
    try {
      const fake = (outcome: { stdout: string; error?: Error & { killed?: boolean } }) =>
        ((_file: string, _args: readonly string[], _options: unknown, callback: Function) => {
          callback(
            outcome.error ?? null,
            outcome.stdout,
            outcome.error ? "ssh: connect to host: timed out" : "",
          );
        }) as unknown as typeof execFile;
      const notRunning = createHerdrFleetRun(pc, {
        controlDirectory: root,
        execFile: fake({
          stdout:
            '{"id":"cli:agent:list","error":{"code":"server_not_running","message":"no herdr server"}}\n',
          error: Object.assign(new Error("exit 1"), { killed: false }),
        }),
      });
      await expect(notRunning(["agent", "list"])).rejects.toMatchObject({ code: "server_not_running" });
      const down = createHerdrFleetRun(pc, {
        controlDirectory: root,
        execFile: fake({ stdout: "", error: Object.assign(new Error("exit 255"), { killed: false }) }),
      });
      await expect(down(["agent", "list"])).rejects.toMatchObject({ code: "fleet_unreachable" });
      const refused = createHerdrFleetRun(pc, { controlDirectory: root, execFile: fake({ stdout: "" }) });
      await expect(refused(["server", "stop"])).rejects.toThrow(/not available on a remote fleet/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("fleet routing", () => {
  function localRunner(): HerdrWatchRunner {
    return {
      get: async () => {
        throw new Error("local get");
      },
      resolveTerminal: async () => undefined,
      wait: async () => {
        throw new Error("local wait");
      },
      createTab: async () => "w1:p1",
    };
  }

  it("qualifies every remote id with its fleet and routes qualified ids back to it", async () => {
    const calls: string[][] = [];
    let status = "working";
    const run: HerdrFleetRun = async (args) => {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "list")
        return JSON.stringify({
          result: {
            panes: [
              {
                ...pane("w2:p1J", "term_abc", status),
                cwd: "C:\\src",
                agent_session: { source: "herdr:claude", kind: "id", value: "remote-session" },
              },
            ],
          },
        });
      if (args[0] === "tab") return JSON.stringify({ result: { root_pane: { pane_id: "w2:p9" } } });
      return "{}";
    };
    const runner = routeHerdrFleets(
      localRunner(),
      new Map([["pc", createRemoteHerdrRunner(pc, run, { pollMs: 5 })]]),
    );
    expect(await runner.get("pc/w2:p1J")).toMatchObject({
      paneId: "pc/w2:p1J",
      terminalId: "pc/term_abc",
      workingDirectory: "C:\\src",
      session: { source: "herdr:claude", kind: "id", value: "remote-session" },
    });
    expect(await runner.resolveTerminal("pc/term_abc")).toMatchObject({ status: "working" });
    setTimeout(() => {
      status = "idle";
    }, 20);
    expect(await runner.wait("pc/w2:p1J", new AbortController().signal)).toMatchObject({ status: "idle" });
    // No long-held `agent wait`: the remote side is only ever polled.
    expect(calls.every((call) => call[0] === "pane" && call[1] === "list")).toBe(true);
    expect(await runner.createTab!({ cwd: "C:\\src", label: "x", fleet: "pc" })).toBe("pc/w2:p9");
    expect(await runner.createTab!({ cwd: "/src", label: "x" })).toBe("w1:p1");
    await expect(runner.get("laptop/w1:p1")).rejects.toThrow(/Unknown Herdr fleet laptop/u);
    expect(await runner.transcript!({ paneId: "pc/w2:p1J" } as HerdrAgentSnapshot)).toBeUndefined();
  });

  it("finds a pane made since the shared poll, such as a seat just hired (VUH-1527)", async () => {
    let panes = [pane("w2:p1J", "term_abc", "idle")];
    const run = vi.fn<HerdrFleetRun>(async () => JSON.stringify({ result: { panes } }));
    // A long poll window: only a miss may read the list again.
    const runner = createRemoteHerdrRunner(pc, run, { pollMs: 60_000 });
    expect(await runner.resolveTerminal("term_abc")).toMatchObject({ paneId: "w2:p1J" });
    panes = [...panes, pane("w2:p2", "term_new", "working")];
    expect(await runner.resolveTerminal("term_new")).toMatchObject({ paneId: "w2:p2" });
    expect(await runner.resolveTerminal("term_gone")).toBeUndefined();
  });

  it.each([
    { missing: "terminal_id", malformed: { pane_id: "w2:pBad" } },
    { missing: "pane_id", malformed: { terminal_id: "term_bad" } },
  ])(
    "keeps remote peers visible when one pane lacks $missing and rejects its direct lookup",
    async ({ malformed }) => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const run = vi.fn<HerdrFleetRun>(async (args) => {
        if (args[0] === "pane" && args[1] === "list")
          return JSON.stringify({ result: { panes: [pane("w2:p1J", "term_abc", "idle"), malformed] } });
        if (args[0] === "agent" && args[1] === "get" && args[2] === "w2:pBad")
          return JSON.stringify({ result: { agent: malformed } });
        throw new Error(`unexpected ${args.join(" ")}`);
      });
      const runner = routeHerdrFleets(localRunner(), new Map([["pc", createRemoteHerdrRunner(pc, run)]]));
      try {
        expect(await runner.get("pc/w2:p1J")).toMatchObject({
          paneId: "pc/w2:p1J",
          terminalId: "pc/term_abc",
        });
        expect(await runner.resolveTerminal("pc/term_abc")).toMatchObject({ status: "idle" });
        expect(warning).toHaveBeenCalledOnce();
        expect(warning).toHaveBeenCalledWith(
          "Skipping malformed Herdr pane",
          expect.objectContaining({
            index: 1,
            code: "invalid_herdr_agent_response",
            detail: "Herdr response did not identify the agent pane",
          }),
        );
        await expect(runner.get("pc/w2:pBad")).rejects.toBeInstanceOf(HerdrAgentResponseError);
        await expect(runner.get("pc/w2:pBad")).rejects.toMatchObject({
          code: "invalid_herdr_agent_response",
        });
        expect(run.mock.calls.map(([args]) => args)).toContainEqual(["agent", "get", "w2:pBad"]);
        expect(await runner.get("pc/w2:p1J")).toMatchObject({ status: "idle" });
      } finally {
        warning.mockRestore();
      }
    },
  );
});

describe("watches and hires on a remote fleet", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("persists a PC watch under its qualified id and wakes after a service restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-fleet-watch-"));
    roots.push(root);
    let status = "working";
    const run: HerdrFleetRun = async (args) => {
      if (args[0] === "pane" && args[1] === "list")
        return JSON.stringify({ result: { panes: [pane("w2:p1J", "term_abc", status)] } });
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    const runner = () =>
      routeHerdrFleets(
        {
          get: async () => ({}) as HerdrAgentSnapshot,
          resolveTerminal: async () => undefined,
          wait: async () => ({}) as HerdrAgentSnapshot,
        },
        new Map([["pc", createRemoteHerdrRunner(pc, run, { pollMs: 5 })]]),
      );
    const path = join(root, "herdr-watches.json");
    const first = new HerdrWatchStore(path, { runner: runner() });
    first.start(async () => undefined);
    const armed = await first.watch("conv-1", "pc/w2:p1J", "harvest round 3");
    expect(armed).toMatchObject({ outcome: "watching", terminalId: "pc/term_abc" });
    first.close();

    const woke: string[] = [];
    const second = new HerdrWatchStore(path, { runner: runner() });
    second.start(async (conversationId, prompt) => {
      woke.push(`${conversationId}\n${prompt}`);
    });
    status = "idle";
    await expect.poll(() => woke.length, { timeout: 2_000 }).toBe(1);
    expect(woke[0]).toContain("harvest round 3");
    expect(woke[0]).toContain("pc/w2:p1J");
    second.close();
  });

  it("hires on a fleet only in a granted directory and takes the pty lane there", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-fleet-hire-"));
    roots.push(root);
    const calls: string[][] = [];
    const run: HerdrFleetRun = async (args) => {
      calls.push([...args]);
      if (args[0] === "tab") return JSON.stringify({ result: { root_pane: { pane_id: "w2:p9" } } });
      if (args[0] === "pane" && args[1] === "list")
        return JSON.stringify({ result: { panes: [pane("w2:p9", "term_new", "idle")] } });
      if (args[0] === "agent" && args[1] === "start") return "{}";
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    const store = new HerdrWatchStore(join(root, "watches.json"), {
      runner: routeHerdrFleets(
        {
          get: async () => ({}) as HerdrAgentSnapshot,
          resolveTerminal: async () => undefined,
          wait: async () => ({}) as HerdrAgentSnapshot,
        },
        new Map([["pc", createRemoteHerdrRunner(pc, run, { pollMs: 5 })]]),
      ),
      remoteWorkspace: async (fleet, directory) => fleet === "pc" && directory === "C:\\src\\rivals",
    });
    const refused = await store.spawnSeat({
      schemaVersion: 1,
      harness: "claude",
      title: "Reader",
      workingDirectory: "C:\\Users\\volpe",
      fleet: "pc",
    });
    expect(refused).toMatchObject({ outcome: "failed", reason: "unknown_directory" });
    expect(calls).toEqual([]);
    const hired = await store.spawnSeat({
      schemaVersion: 1,
      harness: "claude",
      title: "Reader",
      workingDirectory: "C:\\src\\rivals",
      fleet: "pc",
    });
    expect(hired).toMatchObject({ outcome: "spawned", seat: { seatId: "pc/term_new", paneId: "pc/w2:p9" } });
    const start = calls.find((call) => call[0] === "agent" && call[1] === "start")!;
    expect(start).toContain("w2:p9");
    // The seat channel is this machine's MCP; a remote seat is reached through its pane.
    expect(start).not.toContain("--dangerously-load-development-channels");
    store.close();
  });
});

describe("census across fleets", () => {
  it("lists each remote fleet under its own heading and reports an unreachable one without hiding the rest", async () => {
    const census = await readHerdrSessionCensus(undefined, {
      runCommand: async () => ({
        stdout: JSON.stringify({
          result: { agents: [{ pane_id: "w1:p1", agent: "claude", agent_status: "idle" }] },
        }),
        stderr: "",
      }),
      fleets: [
        {
          id: "pc",
          session: "default",
          host: "supedupsilly",
          run: async () =>
            JSON.stringify({
              result: {
                agents: [
                  { pane_id: "w2:p1J", terminal_id: "term_abc", agent: "claude", agent_status: "working" },
                ],
              },
            }),
        },
        {
          id: "laptop",
          session: "default",
          host: "laptop",
          run: async () => {
            throw new Error("fleet_unreachable: ssh: connect to host laptop: Operation timed out");
          },
        },
      ],
    });
    expect(census.outcome).toBe("ok");
    const text = census.outcome === "ok" ? census.text : "";
    expect(text).toContain("w1:p1");
    expect(text).toContain("HERDR FLEET pc (ssh supedupsilly, session default");
    expect(text).toContain("pc/w2:p1J");
    expect(text).toMatch(/HERDR FLEET laptop[^\n]*\n {2}unreachable: fleet_unreachable/u);
  });

  it("puts remote seats in the roster with qualified ids and their fleet", async () => {
    const fleet = await readFleet({
      runCommand: async (_command, args) => ({
        stdout:
          args[0] === "api"
            ? JSON.stringify({ result: { snapshot: { workspaces: [] } } })
            : JSON.stringify({ result: { agents: [] } }),
        stderr: "",
      }),
      fleets: [
        {
          id: "pc",
          session: "gaming",
          host: "supedupsilly",
          run: async (args) =>
            args[0] === "api"
              ? JSON.stringify({
                  result: {
                    snapshot: {
                      workspaces: [{ workspace_id: "w2", label: "Rivals", number: 2 }],
                      tabs: [{ tab_id: "t1", label: "Renderer", number: 1 }],
                      panes: [
                        { terminal_id: "term_abc", pane_id: "w2:p1J", workspace_id: "w2", tab_id: "t1" },
                      ],
                    },
                  },
                })
              : JSON.stringify({
                  result: {
                    agents: [
                      {
                        pane_id: "w2:p1J",
                        terminal_id: "term_abc",
                        agent: "claude",
                        agent_status: "working",
                        name: "rivals-lead",
                        cwd: "C:\\src\\rivals",
                        agent_session: { source: "herdr:claude", kind: "id", value: "s1" },
                      },
                      {
                        pane_id: "w2:p2",
                        terminal_id: "term_head",
                        agent: "claude",
                        name: "clankie",
                        agent_status: "idle",
                        agent_session: { source: "herdr:claude", kind: "id", value: "head" },
                      },
                    ],
                  },
                }),
        },
      ],
    });
    expect(fleet.seats).toEqual([
      expect.objectContaining({
        seatId: "pc/term_abc",
        paneId: "pc/w2:p1J",
        subject: "pc-rivals-lead",
        fleet: "pc",
        herdrSession: "gaming",
        placement: {
          workspace: { id: "w2", label: "Rivals", number: 2 },
          tab: { id: "t1", label: "Renderer", number: 1 },
        },
        workingDirectory: "C:\\src\\rivals",
      }),
    ]);
  });
});

describe("registering an ssh fleet", () => {
  it("requires the remote session to answer, reports unreachable later, and grants exact remote directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-fleet-register-"));
    try {
      const settings = new SettingsStore(join(root, "settings.json"));
      let up = true;
      const seen: string[][] = [];
      const runtimes = new ExecutionConnections({
        settings,
        primary: { binding: () => undefined, status: () => "disabled" },
        fleetRun: (fleet) => async (args) => {
          seen.push([fleet.id, fleet.ssh.host, fleet.session, ...args]);
          if (!up) throw new Error("fleet_unreachable");
          return JSON.stringify({ result: { snapshot: { workspaces: [] } } });
        },
      });
      await runtimes.connect({
        id: "pc",
        session: "default",
        ssh: { host: "volpe@supedupsilly", shell: "powershell" },
      });
      expect(seen[0]).toEqual(["pc", "volpe@supedupsilly", "default", "api", "snapshot"]);
      await expect(
        runtimes.connect({
          id: "pc",
          session: "other",
          ssh: { host: "volpe@supedupsilly", shell: "powershell" },
        }),
      ).rejects.toThrow(/pinned/u);
      await expect(
        runtimes.connect({ id: "pc", socketPath: "/tmp/x.sock", ssh: { host: "h", shell: "posix" } }),
      ).rejects.toThrow();
      await runtimes.connect({
        action: "workspaces",
        id: "pc",
        workspaces: [{ kind: "directory", path: "C:\\src\\Rivals" }],
      });
      await expect(
        runtimes.connect({
          action: "workspaces",
          id: "pc",
          workspaces: [{ kind: "repository", path: "C:\\src" }],
        }),
      ).rejects.toThrow(/exact directories/u);
      expect(await runtimes.remoteWorkspace("pc", "c:/src/rivals/")).toBe(true);
      expect(await runtimes.remoteWorkspace("pc", "C:\\src")).toBe(false);
      expect(await runtimes.fleets()).toEqual([
        { id: "pc", session: "default", ssh: { host: "volpe@supedupsilly", shell: "powershell" } },
      ]);
      expect(await runtimes.configuredBinding("pc")).toBeUndefined();
      expect((await runtimes.list()).find((entry) => entry.id === "pc")).toMatchObject({
        state: "healthy",
        transport: "ssh",
      });
      await runtimes.disconnect("pc");
      expect(await runtimes.fleets()).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("spells herdr add/remove/fleets as runtime connections", () => {
    expect(
      herdrFleetRuntimeArgs([
        "add",
        "pc",
        "--ssh",
        "volpe@supedupsilly",
        "--session",
        "default",
        "--shell",
        "powershell",
      ]),
    ).toEqual([
      "connect",
      "pc",
      "--ssh",
      "volpe@supedupsilly",
      "--session",
      "default",
      "--shell",
      "powershell",
    ]);
    expect(herdrFleetRuntimeArgs(["remove", "pc"])).toEqual(["disconnect", "pc"]);
    expect(herdrFleetRuntimeArgs(["fleets"])).toEqual(["list"]);
    expect(herdrFleetRuntimeArgs(["agent", "list"])).toBeUndefined();
    expect(() => herdrFleetRuntimeArgs(["add", "pc"])).toThrow(/Usage/u);
  });
});
