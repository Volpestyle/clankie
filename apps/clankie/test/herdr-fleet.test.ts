import type { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClankieSettingsSchema, SettingsStore, emptySettings } from "@clankie/settings";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import {
  assertRemoteHerdrArgs,
  createHerdrFleetRun,
  createFleetShellRun,
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
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";
import { RuntimeTerminals } from "../src/captain/runtime-terminals.ts";
import { herdrFleetRuntimeArgs } from "../../tui/src/command/herdr.ts";
import { createHerdrSessionSource } from "@clankie/agent-hosts/sessions";

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

/** `herdr pane process-info`: the pane's shell and its foreground processes. */
function processInfo(paneId: string, shellPid: number, foreground: readonly number[]): string {
  return JSON.stringify({
    result: {
      process_info: {
        pane_id: paneId,
        shell_pid: shellPid,
        foreground_process_group_id: foreground[0] ?? shellPid,
        foreground_processes: (foreground.length === 0 ? [shellPid] : foreground).map((pid) => ({
          pid,
          name: pid === shellPid ? "zsh" : "claude",
          argv: [pid === shellPid ? "zsh" : "claude"],
        })),
      },
    },
  });
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
      ["pane", "move", "w2:p3", "--tab", "w2:t1", "--split", "down", "--target-pane", "w2:p2", "--no-focus"],
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
    const command = remoteHerdrCommand(box, ["pane", "send-text", "w1:p2", "it's $HOME; rm -rf /"]);
    expect(command).toMatch(/^exec sh -c /u);
    // Unquote the single script argument; the inner argv remains exact.
    const script = command.slice("exec sh -c '".length, -1).replaceAll("'\\''", "'");
    expect(script).toContain(
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
      expect.arrayContaining(["BatchMode=yes", "ControlMaster=auto", "ControlPersist=600"]),
    );
    expect(args.some((arg) => /^ControlPath=\/Users\/me\/\.clankie\/ssh\/[a-f0-9]{6}-%C$/u.test(arg))).toBe(
      true,
    );
    expect(args.slice(-3)).toEqual(["--", "volpe@supedupsilly", "cmd"]);
    // OpenSSH expands %C to 40 hex bytes and appends a 17-byte temporary
    // suffix. macOS sockaddr_un leaves 104 bytes including its terminating NUL.
    const longerHome = sshArgs(pc, "/Users/james-alexander/.clankie/ssh", "cmd")
      .find((arg) => arg.startsWith("ControlPath="))!
      .slice("ControlPath=".length)
      .replace("%C", "a".repeat(40));
    expect(Buffer.byteLength(longerHome) + 17 + 1).toBeLessThanOrEqual(104);
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
      if (args[0] === "worktree")
        return JSON.stringify({
          result: { source: { repo_key: "fixture-repo", repo_root: "C:\\src", repo_name: "src" } },
        });
      if (args[0] === "api")
        return JSON.stringify({
          result: {
            snapshot: {
              workspaces: [
                {
                  workspace_id: "w2",
                  label: "src",
                  number: 2,
                  worktree: {
                    repo_key: "fixture-repo",
                    repo_root: "C:\\src",
                    repo_name: "src",
                    is_linked_worktree: false,
                  },
                },
              ],
              tabs: [],
              panes: [],
            },
          },
        });
      if (args[0] === "pane" && (args[1] === "rename" || args[1] === "report-metadata")) return "{}";
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

  it("reads a PC's pane for the connector over ssh, and reports each PC's Herdr as it answers", async () => {
    const calls: string[][] = [];
    const run: HerdrFleetRun = async (args) => {
      calls.push([...args]);
      if (args[0] === "pane" && args[1] === "list")
        return JSON.stringify({ result: { panes: [pane("w2:p1J", "term_abc", "working")] } });
      if (args[0] === "pane" && args[1] === "read")
        return "PS C:\\kh2> claude\r\nBuilding kh2\r\nCompiling...done\r\n";
      if (args[0] === "pane" && args[1] === "process-info") return processInfo("w2:p1J", 400, [401]);
      if (args[0] === "api") return JSON.stringify({ result: { snapshot: { version: "0.9.5" } } });
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    const down: HerdrFleetRun = async () => {
      throw new Error("fleet_unreachable: ssh: connect to host box: Operation timed out");
    };
    const serve = createOperatorService({
      deps: {
        herdrAvailable: () => true,
        fleets: {
          list: [pc, box],
          run: (fleet: HerdrFleet) => (fleet.id === "pc" ? run : down),
          remoteWorkspace: async () => false,
        },
      },
      shutdown: new AbortController(),
      personas: { ready: async () => {} },
      settingsStore: {},
      terminals: new RuntimeTerminals({ defaultAvailable: () => false }),
      herdrRunner: routeHerdrFleets(
        localRunner(),
        new Map([
          ["pc", createRemoteHerdrRunner(pc, run, { pollMs: 5 })],
          ["box", createRemoteHerdrRunner(box, down, { pollMs: 5 })],
        ]),
      ),
    } as unknown as CreateOperatorServiceContext);

    // A seat id names its PC and terminal (ADR 0184); Herdr there reads the pane it sits in.
    expect(await serve({ op: "terminal_read", schemaVersion: 1, terminalId: "pc/term_abc" })).toEqual({
      op: "terminal_read",
      schemaVersion: 1,
      terminalId: "pc/term_abc",
      status: "read",
      text: "Building kh2\r\nCompiling...done\r\n",
    });
    expect(calls).toContainEqual([
      "pane",
      "read",
      "w2:p1J",
      "--source",
      "recent-unwrapped",
      "--format",
      "text",
    ]);
    expect(await serve({ op: "terminal_read", schemaVersion: 1, terminalId: "box/term_zzz" })).toMatchObject({
      status: "unavailable",
      detail: expect.stringContaining("Operation timed out"),
    });
    expect(await serve({ op: "terminal_catalog", schemaVersion: 1, includeMachines: true })).toMatchObject({
      machines: [
        { id: "pc", reachable: true, herdrVersion: "0.9.5" },
        { id: "box", reachable: false },
      ],
    });
  });

  it("reads only a live agent's pane, and only what its current agent showed", async () => {
    // One PC pane over the real remote runner and operator service; only Herdr's answers are stood in.
    let agent = "claude";
    let session = "session-one";
    let foreground: number[] = [401];
    let history = "";
    let screen = "";
    const run: HerdrFleetRun = async (args) => {
      if (args[0] === "pane" && args[1] === "list")
        return JSON.stringify({
          result: {
            panes: [
              pane("w2:p1J", "term_abc", "working", {
                agent,
                agent_session: { source: "herdr:claude", kind: "id", value: session },
              }),
            ],
          },
        });
      if (args[0] === "pane" && args[1] === "process-info") return processInfo("w2:p1J", 400, foreground);
      if (args[0] === "pane" && args[1] === "read") return args[4] === "visible" ? screen : history;
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    const serve = createOperatorService({
      deps: {
        herdrAvailable: () => true,
        fleets: { list: [pc], run: () => run, remoteWorkspace: async () => false },
      },
      shutdown: new AbortController(),
      personas: { ready: async () => {} },
      settingsStore: {},
      terminals: new RuntimeTerminals({ defaultAvailable: () => false }),
      herdrRunner: routeHerdrFleets(
        localRunner(),
        // No shared poll: each read sees the pane as Herdr answers now.
        new Map([["pc", createRemoteHerdrRunner(pc, run, { pollMs: 0 })]]),
      ),
    } as unknown as CreateOperatorServiceContext);
    const read = () => serve({ op: "terminal_read", schemaVersion: 1, terminalId: "pc/term_abc" });

    // A plain shell, by Herdr's detection or by its foreground, is never read.
    agent = "unknown";
    history = "$ cat .env\nTOKEN=owner-secret\n$ ";
    screen = history;
    expect(await read()).toMatchObject({
      status: "unavailable",
      detail: "No coding agent is running in that pane now.",
    });
    agent = "claude";
    foreground = [];
    expect(await read()).toMatchObject({
      status: "unavailable",
      detail: "No coding agent is running in that pane now.",
    });
    // The connector's session source takes that refusal as final, never streaming the screen instead.
    let tailed = false;
    const source = createHerdrSessionSource(
      {
        dispatch: async (request) => serve(request),
        terminalTail: async () => {
          tailed = true;
          throw new Error("tailed");
        },
        tailRefusal: async () => new Error("tailed"),
      },
      { surfaceClientId: "connector" },
    );
    await expect(source.read("pc/term_abc", 20)).rejects.toThrow(
      "No coding agent is running in that pane now.",
    );
    expect(tailed).toBe(false);

    // The agent starts below the owner's earlier shell work, still on its screen: its reads start
    // after the line that launched it.
    foreground = [401];
    history = "$ cat .env\nTOKEN=owner-secret\n$ claude\n\n Claude Code\n> fix the build";
    screen = history;
    expect(await read()).toMatchObject({ status: "read", text: "\n Claude Code\n> fix the build" });

    // A new occupant (here a new native session) starts over after its own launch, even where
    // the shell work above it repeats the lines it is cut at.
    session = "session-two";
    history = `${"$ cat .env\nTOKEN=owner-secret\n".repeat(3)}$ claude\n\n Claude Code\n> fix the build`;
    screen = "$ claude\n\n Claude Code\n> fix the build";
    expect(await read()).toMatchObject({ status: "read", text: "\n Claude Code\n> fix the build" });

    // Later reads add what it wrote since, and still never the shell work above it.
    history = `${history}\n Reading files\n Build fixed`;
    screen = " Claude Code\n> fix the build\n Reading files\n Build fixed";
    const later = await read();
    expect(later).toMatchObject({ status: "read" });
    expect(later.op === "terminal_read" && later.text).toBe(
      "\n Claude Code\n> fix the build\n Reading files\n Build fixed",
    );

    session = "session-three";
    history = `${history}\n$ claude --resume\n Claude Code\n> next task`;
    screen = "$ claude --resume\n Claude Code\n> next task";
    expect(await read()).toMatchObject({ status: "read", text: " Claude Code\n> next task" });

    // While only part of the history it was cut at has scrolled out, the cut still holds.
    history = " Build fixed\n$ claude --resume\n Claude Code\n> next task\n Done";
    screen = " Claude Code\n> next task\n Done";
    expect(await read()).toMatchObject({ status: "read", text: " Claude Code\n> next task\n Done" });

    // The agent exits, the owner works in the shell, and the same native session is resumed:
    // a new process is a new occupant, so the shell work stays out.
    foreground = [];
    expect(await read()).toMatchObject({ status: "unavailable" });
    foreground = [402];
    history = `${history}\n$ cat .env\nTOKEN=owner-again\n$ claude --resume\n Claude Code\n> back`;
    screen = "$ claude --resume\n Claude Code\n> back";
    expect(await read()).toMatchObject({ status: "read", text: " Claude Code\n> back" });

    // Once the line it was cut at is gone, scrolled out or redrawn, the pane's text from before
    // it stays out line by line, an agent line repeating that text included.
    history = "TOKEN=owner-again\n Claude Code\n> back\n All done";
    screen = history;
    expect(await read()).toMatchObject({ status: "read", text: "> back\n All done" });

    // Started under a name its launch line doesn't show (an alias), the agent's first screen is
    // held back whole, and the read says why; what it writes next is shown.
    foreground = [403];
    history = "$ cat .env\nTOKEN=owner-third\n$ cc\n Claude Code\n> hello";
    screen = history;
    const hidden = await read();
    expect(hidden).toMatchObject({
      status: "read",
      text: "",
      detail: "Earlier screen hidden until this agent prints something new.",
    });
    history = `${history}\n Hi! What are we building?`;
    screen = history;
    expect(await read()).toMatchObject({
      status: "read",
      text: " Hi! What are we building?",
      detail: "Earlier screen hidden until this agent prints something new.",
    });
    // The connector's session source passes that note on with the text.
    expect(await source.read("pc/term_abc", 20)).toEqual({
      id: "pc/term_abc",
      text: " Hi! What are we building?",
      note: "Earlier screen hidden until this agent prints something new.",
    });
  });

  it("lists an agent the owner opened by hand on a PC, once, and reads it there over ssh", async () => {
    // PC2 is reached by two connections to one Herdr session; Clankie hired nothing on it.
    const pc2: HerdrFleet = {
      id: "pc2",
      session: "default",
      ssh: { host: "ccroc@bld", shell: "powershell" },
    };
    const pc2Again: HerdrFleet = { ...pc2, id: "pc2-alt" };
    const snapshot = JSON.stringify({
      result: {
        snapshot: {
          version: "0.9.5",
          workspaces: [{ workspace_id: "w1", label: "kh2", number: 1 }],
          tabs: [{ tab_id: "t1", label: "Agents", number: 1 }],
          panes: [
            {
              pane_id: "w1:p1",
              terminal_id: "term_claude",
              workspace_id: "w1",
              tab_id: "t1",
              agent: "claude",
              title: "kh2 read run",
            },
            { pane_id: "w1:p2", terminal_id: "term_shell", workspace_id: "w1", tab_id: "t1", title: "pwsh" },
          ],
        },
      },
    });
    const run: HerdrFleetRun = async (args) => {
      if (args[0] === "api") return snapshot;
      if (args[0] === "pane" && args[1] === "list")
        return JSON.stringify({ result: { panes: [pane("w1:p1", "term_claude", "idle")] } });
      if (args[0] === "pane" && args[1] === "process-info") return processInfo("w1:p1", 400, [401]);
      if (args[0] === "pane" && args[1] === "read") return "PS C:\\kh2> claude\r\nMapped 3 save slots\r\n";
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    const serve = createOperatorService({
      deps: {
        herdrAvailable: () => true,
        fleets: { list: [pc2, pc2Again], run: () => run, remoteWorkspace: async () => false },
      },
      shutdown: new AbortController(),
      personas: { ready: async () => {} },
      settingsStore: {},
      terminals: new RuntimeTerminals({ defaultAvailable: () => false }),
      herdrRunner: routeHerdrFleets(
        localRunner(),
        new Map([
          ["pc2", createRemoteHerdrRunner(pc2, run, { pollMs: 5 })],
          ["pc2-alt", createRemoteHerdrRunner(pc2Again, run, { pollMs: 5 })],
        ]),
      ),
    } as unknown as CreateOperatorServiceContext);
    // The connector's own session source over this service; Clankie's fleet has no seats.
    const source = createHerdrSessionSource(
      {
        dispatch: async (request) =>
          request.op === "fleet"
            ? ({ op: "fleet", schemaVersion: 1, snapshot: { personas: [], seats: [] } } as never)
            : serve(request),
        terminalTail: async () => {
          throw new Error("no tail");
        },
        tailRefusal: async () => new Error("no tail"),
      },
      { surfaceClientId: "connector" },
    );

    const listed = await source.list();
    expect(listed.sessions).toEqual([
      {
        id: "pc2/term_claude",
        source: "herdr",
        harness: "claude",
        machine: "pc2",
        title: "kh2 read run",
        canMessage: false,
      },
    ]);
    expect(listed.machines).toEqual(["pc2", "pc2-alt"]);
    expect((await source.read("pc2/term_claude", 20)).text).toContain("Mapped 3 save slots");
  });

  it("starts a connected app's agent only in a granted project checkout, led by Clankie's own thread", async () => {
    const settings = ClankieSettingsSchema.parse({
      ...emptySettings(),
      machines: [{ id: "pc", ssh: "volpe@supedupsilly", shell: "powershell" }],
      execution: {
        ...emptySettings().execution,
        connections: [
          // A second Herdr session on the same PC, listed first, never granted the checkout.
          {
            id: "pc-work",
            machine: "pc",
            session: "work",
            ssh: { host: "volpe@supedupsilly", shell: "powershell" },
          },
          {
            id: "pc",
            machine: "pc",
            session: "default",
            ssh: { host: "volpe@supedupsilly", shell: "powershell" },
          },
        ],
      },
      projects: ProjectsSettingsSchema.parse({
        projects: [
          {
            id: "kh2",
            name: "kh2",
            workspaces: [
              { id: "pc", machineId: "pc", platform: "windows", path: "C:\\code\\kh2" },
              // Registered to the project, but the owner never granted it on that machine.
              { id: "pc-old", machineId: "pc", platform: "windows", path: "C:\\old\\kh2" },
            ],
          },
        ],
      }),
    });
    const hires: { seat: Record<string, unknown>; brief?: string; lead: string }[] = [];
    let leading = true;
    let nextHire: Record<string, unknown> | undefined;
    const serve = createOperatorService({
      deps: {
        herdrAvailable: () => true,
        fleets: {
          list: [pc],
          run: () => async () => "{}",
          remoteWorkspace: async (fleet: string, directory: string) =>
            fleet === "pc" && directory === "C:\\code\\kh2",
        },
      },
      shutdown: new AbortController(),
      personas: { ready: async () => {} },
      settingsStore: {},
      settings: async () => settings,
      conversations: { runsCaptainTurns: (id: string) => leading && id === "global-default" },
      hireSeat: async (
        seat: Record<string, unknown>,
        brief: string | undefined,
        authority: { owner: { conversationId: string } },
      ) => {
        hires.push({ seat, ...(brief === undefined ? {} : { brief }), lead: authority.owner.conversationId });
        return nextHire ?? { outcome: "spawned", seat: { seatId: "pc/term_new" } };
      },
    } as unknown as CreateOperatorServiceContext);

    const place = { machine: "volpe@supedupsilly", project: "kh2", workingDirectory: "C:\\code\\kh2" };
    expect(await serve({ op: "start_agent", schemaVersion: 1 })).toEqual({
      op: "start_agent",
      schemaVersion: 1,
      status: "places",
      places: [place],
    });
    // The ungranted checkout and any other directory are refused before anything starts.
    for (const workingDirectory of ["C:\\old\\kh2", "C:\\Windows"])
      expect(
        await serve({ op: "start_agent", schemaVersion: 1, machine: "pc", workingDirectory }),
      ).toMatchObject({ status: "refused" });
    expect(hires).toEqual([]);

    expect(
      await serve({
        op: "start_agent",
        schemaVersion: 1,
        machine: "volpe@supedupsilly",
        workingDirectory: "C:\\code\\kh2",
        harness: "codex",
        prompt: "fix the netcode desync",
      }),
    ).toMatchObject({ status: "started", seatId: "pc/term_new" });
    expect(hires).toEqual([
      {
        seat: expect.objectContaining({
          harness: "codex",
          workingDirectory: "C:\\code\\kh2",
          fleet: "pc",
          projectId: "kh2",
          hireKind: "worker",
          // A work hire must name its effort, and this project sets none.
          effort: "medium",
          effortReason: expect.any(String),
        }),
        brief: "fix the netcode desync",
        lead: "global-default",
      },
    ]);
    // A refused hire says why, in the app's answer, not only "couldn't start it".
    nextHire = { outcome: "failed", reason: "not_ready", detail: "Start checkout is dirty" };
    expect(
      await serve({ op: "start_agent", schemaVersion: 1, machine: "pc", workingDirectory: "C:\\code\\kh2" }),
    ).toMatchObject({
      status: "refused",
      detail: "That checkout isn't ready to start an agent from. Clankie said: Start checkout is dirty.",
    });
    nextHire = undefined;
    // With nobody to lead it, nothing starts.
    leading = false;
    expect(
      await serve({ op: "start_agent", schemaVersion: 1, machine: "pc", workingDirectory: "C:\\code\\kh2" }),
    ).toMatchObject({ status: "refused" });
    expect(hires).toHaveLength(2);
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
      if (args[0] === "worktree")
        return JSON.stringify({
          result: { source: { repo_key: "fixture-repo", repo_root: "C:\\src", repo_name: "src" } },
        });
      if (args[0] === "api")
        return JSON.stringify({
          result: {
            snapshot: {
              workspaces: [
                {
                  workspace_id: "w2",
                  label: "src",
                  number: 2,
                  worktree: {
                    repo_key: "fixture-repo",
                    repo_root: "C:\\src",
                    repo_name: "src",
                    is_linked_worktree: false,
                  },
                },
              ],
              tabs: [],
              panes: [],
            },
          },
        });
      if (args[0] === "pane" && (args[1] === "rename" || args[1] === "report-metadata")) return "{}";
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
      // A hire's own worktree inside the granted checkout, and its twin of a granted subfolder.
      expect(await runtimes.remoteWorkspace("pc", "C:/src/Rivals/.local/wt-nell-1a2b3c")).toBe(true);
      expect(await runtimes.remoteWorkspace("pc", "C:\\src\\.local\\wt-nell-1a2b3c\\Rivals")).toBe(true);
      expect(await runtimes.remoteWorkspace("pc", "C:\\src\\.local\\wt-nell-1a2b3c")).toBe(false);
      expect(await runtimes.remoteWorkspace("pc", "C:\\src\\Rivals\\.local\\notes")).toBe(false);
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

it("marks only a proven pre-channel mux rejection as not sent", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-mux-negative-"));
  try {
    for (const [stdout, stderr, definitive] of [
      ["", "mm_send_fd: sendmsg(2): Message too long\n", "not_sent"],
      ["remote output", "mm_send_fd: sendmsg(2): Message too long\n", undefined],
      ["", "Connection reset by peer", undefined],
    ] as const) {
      const fake = ((_file: string, _args: readonly string[], _options: unknown, callback: Function) => {
        callback(Object.assign(new Error(stderr), { code: 255 }), stdout, stderr);
      }) as unknown as typeof execFile;
      const shell = createFleetShellRun(pc, { controlDirectory: root, execFile: fake });
      await expect(shell(remoteHerdrCommand(pc, ["agent", "list"]))).rejects.toMatchObject({ definitive });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
