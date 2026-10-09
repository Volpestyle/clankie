import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createOpenCodeNativeHost } from "../src/captain/opencode-native-host.ts";
import { createOpenCodeSeatAdapter } from "../src/captain/opencode-seat-adapter.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { occupantIdForHerdrSession, readFleet } from "../src/captain/herdr-census.ts";
import { withSeatSubagents } from "../src/captain/seat-subagents.ts";
import { createAgentSessions } from "../src/agent-sessions.ts";
import { OpenCodeProfiles } from "../src/opencode-profiles.ts";
import { remoteOpenCodeFixture } from "./helpers/remote-opencode-fixture.ts";
import { writeOpenCodeNativeSession } from "./helpers/opencode-native-db.ts";

// Integration, not a native invocation: only OS/Herdr and SDK input boundaries
// are fixtures. The hire, prepared host, controller/WebSocket, worker runtime,
// SQLite registration, census, personas, conversations and roster are real.
// Pinned native shapes come from the VUH-1586 live checkpoint. Real native E2E
// is a separate guarded private-service run; no provider/account is used here.
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  options: {
    remote?: boolean;
    preferencesOnly?: boolean;
    historyFirst?: boolean;
    assignRole?: boolean;
    /** Hire from the global operator seat into a project workspace registered on the fleet's machine. */
    operatorSeat?: boolean;
  } = {},
) {
  const {
    remote = false,
    preferencesOnly = false,
    historyFirst = false,
    assignRole = true,
    operatorSeat = false,
  } = options;
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-fleet-integration-")));
  const projectName = "OpenCode lifecycle";
  const tabLabel = preferencesOnly
    ? projectName
    : remote
      ? operatorSeat
        ? "Remote app"
        : "Fixture project"
      : "Workers";
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "captain");
  const sessionId = "ses_nativeWorker123";
  const pane = {
    pane_id: "w1:p1",
    terminal_id: "term_native123",
    agent: "opencode",
    agent_status: "idle",
    cwd: root,
    terminal_title: "OC | native-integration",
    label: "Native command",
    tokens: {} as Record<string, string>,
    name: undefined as string | undefined,
    agent_session: undefined as { source: string; kind: string; value: string } | undefined,
  };
  const unrelated = {
    ...pane,
    pane_id: "w1:p2",
    terminal_id: "term_unaddressed456",
    name: "owner-started-worker",
    terminal_title: "OC | Owner task",
    agent_session: { source: "herdr:opencode", kind: "id", value: "ses_unaddressed456" },
  };
  let present = false;
  let route: { name: string; params?: { sessionID: string } } = { name: "home" };
  let ready = false;
  let dispose = () => {};
  let initialization: Promise<void> | undefined;
  let database = "";
  let exitCommands = 0;
  let physicalCloses = 0;
  const receivedBriefs: string[] = [];
  let layouts = 0;
  let messages = 0;
  let sendFailure = false;
  let sessionStatus: "idle" | "busy" = "idle";
  let nextPromptStartsTurn = false;
  const reportedStates: string[] = [];
  let nextReport: (() => Promise<void>) | undefined;
  const execute = promisify(execFile);
  const socketSamples = new Map<string, Promise<string>>();
  const executable = await realpath(process.execPath);
  const sourceUrl = new URL("../../../integrations/opencode-plugin/worker-tui.mjs", import.meta.url);
  const source = (await readFile(sourceUrl, "utf8"))
    .replace(
      'import { createComputed, createRoot } from "solid-js";',
      "const createComputed = fn => fn(); const createRoot = fn => fn(() => {});",
    )
    .replace(
      'from "./worker-runtime.mjs"',
      `from ${JSON.stringify(new URL("worker-runtime.mjs", sourceUrl).href)}`,
    );
  const loader = join(root, "worker-tui.mjs");
  await writeFile(loader, source);
  const module = (await import(pathToFileURL(loader).href)) as {
    default: { tui(api: unknown, options: unknown): Promise<void> };
  };
  const api = {
    app: { version: "1.18.18" },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose(fn: () => void) {
        dispose = fn;
      },
    },
    route: {
      get current() {
        return route;
      },
      navigate(name: string, params: { sessionID: string }) {
        route = { name, params };
      },
    },
    keymap: {
      dispatchCommand(name: string) {
        expect(name).toBe("app.exit");
        exitCommands++;
        present = false; // Herdr's PaneDied removes the command pane.
        dispose(); // Native exit can drop the reply; disappearance is the proof.
      },
    },
    state: {
      get ready() {
        return ready;
      },
      config: { mcp: { clankie: { type: "local", command: ["clankie", "mcp", "--fleet"], enabled: true } } },
      session: { permission: () => [], question: () => [], status: () => ({ type: sessionStatus }) },
    },
    client: {
      session: {
        async create() {
          await writeOpenCodeNativeSession(database, root, sessionId);
          return { data: { id: sessionId } };
        },
        get: async () => ({ data: { id: sessionId, directory: root } }),
        status: async () => ({
          data: sessionStatus === "idle" ? {} : { [sessionId]: { type: sessionStatus } },
        }),
        messages: async () => ({ data: [] }),
        promptAsync: async (input: { parts: { type: string; text: string }[] }) => {
          receivedBriefs.push(input.parts[0]!.text);
          messages++;
          if (sendFailure) throw new Error("Fixture native acknowledgment lost");
          if (nextPromptStartsTurn) {
            nextPromptStartsTurn = false;
            sessionStatus = "busy";
          }
          return { response: { status: 204 } };
        },
      },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
    },
  };
  cleanups.push(async () => dispose());
  const nativeRequest = async (_binding: unknown, method: string, input: unknown) => {
    const params = input as Record<string, unknown>;
    if (method === "layout.apply") {
      layouts++;
      expect(params.workspace_id).toBe("w1");
      expect(params.tab_label).toBe(tabLabel);
      const command = params.root as { env: Record<string, string> };
      const config = JSON.parse(await readFile(command.env.OPENCODE_TUI_CONFIG!, "utf8"));
      database = command.env.OPENCODE_DB!;
      present = true;
      initialization = module.default.tui(api, config.plugin.at(-1)[1]).then(() => {
        ready = true;
      });
      return { result: { layout: { root: { type: "pane", pane_id: pane.pane_id } } } };
    }
    if (!present) throw new Error("pane_not_found");
    if (method === "pane.process_info")
      return {
        result: {
          process_info: {
            pane_id: pane.pane_id,
            shell_pid: process.pid,
            foreground_process_group_id: process.pid,
          },
        },
      };
    if (method === "pane.get") return { result: { pane: { ...pane } } };
    if (method === "pane.report_agent") {
      const wait = nextReport;
      nextReport = undefined;
      await wait?.();
      pane.agent_status = String(params.state);
      reportedStates.push(pane.agent_status);
      pane.agent_session = {
        source: String(params.source),
        kind: "id",
        value: String(params.agent_session_id),
      };
      return { result: { type: "ok" } };
    }
    if (method === "agent.rename") {
      pane.name = String(params.name);
      return { result: { agent: { ...pane } } };
    }
    throw new Error(`Unexpected native method ${method}`);
  };
  const native = createOpenCodeNativeHost({
    binding: async () => ({ runtime: "external", session: "fixture", socketPath: join(root, "herdr.sock") }),
    platform: "darwin",
    processHelper: "/fixture/process-birth.py",
    run: async (file, args) => {
      if (file === "/usr/bin/python3")
        return JSON.stringify({
          pid: process.pid,
          uid: process.getuid!(),
          birth: ["1700000000", "123456"],
          executable,
          cwd: root,
        });
      // One real loopback ownership sample per fixture socket. Other OS facts
      // are golden inputs too; the live E2E repeats lifetime/owner observation.
      const key = JSON.stringify(args);
      let sample = socketSamples.get(key);
      if (!sample) {
        // This fixture owns both TCP ends in this PID. Keep the real positive
        // socket ownership proof; skip unrelated filesystem stat/readlink probes
        // with -b because cwd and process birth are already golden inputs above.
        sample = execute(file, ["-b", "-p", String(process.pid), ...args]).then((result) => result.stdout);
        socketSamples.set(key, sample);
      }
      return sample;
    },
    request: nativeRequest,
  });
  const herdr = async (args: readonly string[]) => {
    if (args[0] === "pane" && args[1] === "list")
      return JSON.stringify({ result: { panes: present ? [pane, unrelated] : [unrelated] } });
    if (args[0] === "agent" && args[1] === "list")
      return JSON.stringify({ result: { agents: present ? [pane, unrelated] : [unrelated] } });
    if (args[0] === "agent" && args[1] === "get" && present)
      return JSON.stringify({ result: { agent: pane } });
    if (args[0] === "worktree" && args[1] === "list") {
      expect(args).toEqual(["worktree", "list", "--cwd", root]);
      // The fixture directory has no Git identity, as real Herdr reports it.
      throw new Error(JSON.stringify({ error: { code: "not_git_worktree", message: "not a Git worktree" } }));
    }
    if (args[0] === "api" && args[1] === "snapshot")
      return JSON.stringify({
        result: {
          snapshot: {
            workspaces: [{ workspace_id: "w1", label: "Fixture", number: 1 }],
            tabs: [
              { tab_id: "w1:t1", workspace_id: "w1", label: "Owner task" },
              ...(present ? [{ tab_id: "w1:t2", workspace_id: "w1", label: tabLabel }] : []),
            ],
            panes: [
              { ...unrelated, workspace_id: "w1", tab_id: "w1:t1" },
              ...(present ? [{ ...pane, workspace_id: "w1", tab_id: "w1:t2" }] : []),
            ],
          },
        },
      });
    if (args[0] === "pane" && args[1] === "rename") {
      expect(present).toBe(true);
      expect(args[2]).toBe(pane.pane_id);
      pane.label = args[3]!;
      return JSON.stringify({ result: { pane: { ...pane } } });
    }
    if (args[0] === "pane" && args[1] === "report-metadata") {
      expect(present).toBe(true);
      expect(args[2]).toBe(pane.pane_id);
      expect(args[args.indexOf("--source") + 1]).toBe("clankie-hire-layout");
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== "--token") continue;
        const [name, value] = args[i + 1]!.split("=");
        pane.tokens[name!] = value!;
      }
      return "";
    }
    if (args[0] === "pane" && args[1] === "close") {
      physicalCloses++;
      throw new Error("Unconditional pane close forbidden");
    }
    throw new Error(`Unsupported Herdr fixture command ${args.join(" ")}`);
  };
  const ssh = remote ? await remoteOpenCodeFixture({ root, state, executable, nativeRequest }) : undefined;
  if (ssh) cleanups.push(() => ssh.close());
  if (ssh && historyFirst) expect(await ssh.workers.list(ssh.fleet.id)).toEqual([]);
  const runner = createHerdrWatchRunner(undefined, herdr, native.createCommandTab);
  const adapter = createOpenCodeSeatAdapter({
    repoRoot: fileURLToPath(new URL("../../../", import.meta.url)),
    stateDir: state,
    native,
    discover: async () => ({ executable, version: "1.18.18" }),
    timeoutMs: 3000,
  });
  const settings = new SettingsStore(join(root, "settings.json"));
  if (ssh) {
    await settings.update((current) => ({
      ...current,
      machines: [{ id: "fixture-box", ssh: ssh.fleet.ssh.host, shell: ssh.fleet.ssh.shell, aliases: [] }],
      machineAccess: { "fixture-box": "workers" },
      execution: {
        ...current.execution,
        connections: [
          {
            id: ssh.fleet.id,
            machine: "fixture-box",
            session: ssh.fleet.session,
            kind: "herdr",
            enabled: true,
            capabilities: ["code"],
          },
        ],
      },
    }));
  }
  if (preferencesOnly)
    await settings.update((current) => ({
      ...current,
      autonomy: { fleet: { ...current.autonomy.fleet, commit: "owner", push: "owner" } },
      projects: ProjectsSettingsSchema.parse({
        projects: [
          {
            id: "native",
            name: projectName,
            workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: root }],
            autonomy: {
              fleet: {
                push: "lead",
                release: { mode: "time_rule", rule: "After one week with changes." },
                verification: "review_and_seal",
                reportingStyle: "Evidence links first.",
              },
            },
          },
        ],
      }),
    }));
  if (ssh && operatorSeat)
    // The owner's live shape: one machine reached by two Herdr connections, with the
    // project workspace registered under the sibling connection rather than the hiring one.
    await settings.update((current) => ({
      ...current,
      machines: [{ id: "fixture-box", ssh: ssh.fleet.ssh.host, shell: ssh.fleet.ssh.shell, aliases: [] }],
      execution: {
        ...current.execution,
        connections: [
          {
            id: ssh.fleet.id,
            machine: "fixture-box",
            session: ssh.fleet.session,
            kind: "herdr",
            capabilities: ["code"],
            enabled: true,
          },
          {
            id: "fixture-desk",
            machine: "fixture-box",
            session: "desk",
            kind: "herdr",
            capabilities: ["code"],
            enabled: true,
          },
        ],
      },
      projects: ProjectsSettingsSchema.parse({
        projects: [
          {
            id: "home",
            name: "Home",
            workspaces: [{ id: "home", machineId: "local", platform: "posix", path: state }],
          },
          {
            id: "remote-app",
            name: "Remote app",
            workspaces: [{ id: "remote", machineId: "fixture-desk", platform: "posix", path: root }],
          },
        ],
      }),
    }));
  else if (ssh && !preferencesOnly)
    await settings.update((current) => ({
      ...current,
      projects: ProjectsSettingsSchema.parse({
        projects: [
          {
            id: "default",
            name: "Fixture project",
            workspaces: [{ id: "local", machineId: "local", path: root, platform: "posix" }],
          },
        ],
      }),
    }));
  const sessions = createAgentSessions(settings, undefined, new OpenCodeProfiles(state), ssh?.workers);
  const census = async (_command: string, args: readonly string[]) => ({
    stdout: await herdr(args),
    stderr: "",
  });
  // This path only reads native sessions; fail if it reaches another port.
  const unused = (): never => {
    throw new Error("Unexpected captain dependency");
  };
  const deps: CaptainDeps = {
    agentSessions: sessions,
    ...(ssh === undefined
      ? {}
      : {
          fleets: {
            list: [ssh.fleet],
            current: ssh.fleets,
            run: () => herdr,
            shell: () => ssh.shell,
            remoteWorkspace: async () => true,
          },
        }),
    mcp: { catalog: async () => [], call: unused },
    email: { list: unused, read: unused, search: unused, send: unused },
    browser: { catalog: async () => ({ schemaVersion: 1, available: false, tools: [] }), call: unused },
    media: { generateImage: unused, generateVideo: unused, finishedRenders: unused },
    embodiment: { submitIntent: unused, getSession: unused, getLiveSession: unused },
    activity: { current: unused },
    presence: { listSessions: unused, listVoiceHistory: unused, listRecentVoiceSpeech: unused },
    memory: {
      writeMemory: unused,
      recallMemoryCard: unused,
      searchMemory: unused,
      editMemory: unused,
      forgetMemory: unused,
    },
  };
  const captain = createCaptain(deps, {
    repoRoot: root,
    stateDir: state,
    settings,
    seatAdapters: ssh ? [] : [adapter],
    ...(ssh === undefined ? {} : { remoteOpenCode: ssh.workers }),
    nativeHerdrRunner: ssh
      ? createHerdrWatchRunner(undefined, async () => {
          throw new Error("Local fallback forbidden");
        })
      : runner,
    nativeCensusRunner: census,
    projectHireTools: async () => [],
    projectHireIdentity: async (fleet, selectedPane) =>
      pane.agent_session === undefined
        ? undefined
        : {
            fleet,
            pane: selectedPane,
            nativeOccupantId: occupantIdForHerdrSession({ ...pane.agent_session, kind: "id" }),
            binding: { socketPath: join(root, "herdr.sock"), session: "fixture" },
            shell: { pid: process.pid, startTime: "fixture-shell-birth" },
            processes: [{ pid: process.pid, startTime: "fixture-native-birth" }],
          },
  });
  cleanups.push(() => captain.close());
  const created = await captain.serveOperatorConversation({
    schemaVersion: 1,
    op: "create",
    scope:
      (ssh && !operatorSeat) || preferencesOnly
        ? { kind: "workspace", workspaceId: root }
        : { kind: "global" },
    title: "Native hire",
  });
  if (created.op !== "create") throw new Error("create expected");
  const hired = await captain.serveOperatorConversation({
    schemaVersion: 1,
    op: "spawn_seat",
    conversationId: created.conversation.conversationId,
    seat: {
      schemaVersion: 1,
      harness: "opencode",
      title: "Oriana Vale",
      ...(assignRole ? { role: "tester" } : {}),
      workingDirectory: root,
      ...(ssh === undefined ? {} : { fleet: ssh.fleet.id }),
      ...(operatorSeat ? { projectId: "remote-app" } : {}),
    },
    ...(preferencesOnly ? {} : { brief: "Fixture native brief" }),
  });
  if (hired.op !== "spawn_seat" || hired.result.outcome !== "spawned") throw new Error(JSON.stringify(hired));
  await initialization;
  // Sanitized VUH-1586 1.18.18 live task shape. Session ids/description/output
  // are fixture-owned; callID and native times are retained from that run.
  const task = {
    type: "tool",
    tool: "task",
    callID: "call_YDhIpf2dXavUjmaEQVxAtG76",
    state: {
      status: "running",
      input: { subagent_type: "general", description: "Lifecycle proof" },
      time: { start: 1791147896370 },
      metadata: { sessionId: "ses_fixtureChild123" },
    },
  };
  const db = new DatabaseSync(database);
  db.exec("PRAGMA foreign_keys=OFF");
  db.prepare(
    "INSERT INTO session(id,project_id,parent_id,slug,directory,title,version,time_created,time_updated) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    "ses_fixtureChild123",
    "project",
    sessionId,
    "child",
    root,
    "Lifecycle proof (@general subagent)",
    "1.18.18",
    1791147896370,
    1791147964419,
  );
  db.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run(
    "msg_nativeTask123",
    sessionId,
    1791147896370,
    1791147896370,
    JSON.stringify({ role: "assistant", time: { created: 1791147896370 } }),
  );
  db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run(
    "prt_nativeTask123",
    "msg_nativeTask123",
    sessionId,
    1791147896370,
    1791147896370,
    JSON.stringify(task),
  );
  db.close();
  const completeTask = () => {
    const db = new DatabaseSync(database);
    try {
      db.prepare("UPDATE part SET data=? WHERE id=?").run(
        JSON.stringify({
          ...task,
          state: {
            ...task.state,
            status: "completed",
            time: { start: 1791147896370, end: 1791147964419 },
            output: '<task id="ses_fixtureChild123" state="completed">Fixture result</task>',
          },
        }),
        "prt_nativeTask123",
      );
    } finally {
      db.close();
    }
  };
  return {
    captain,
    pane,
    hired: hired.result,
    census,
    sessions,
    settings,
    database,
    root,
    receivedBriefs,
    reportedStates,
    pauseNextReport: () => {
      let entered!: () => void, resume!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      nextReport = async () => {
        entered();
        await gate;
      };
      return { waiting, resume };
    },
    startNextPrompt: () => {
      nextPromptStartsTurn = true;
    },
    completeTask,
    counts: () => ({ exitCommands, physicalCloses }),
    ssh,
    created,
    deliveries: () => ({ messages, layouts }),
    loseSend: () => {
      sendFailure = true;
    },
    switchRoute: () => {
      route = { name: "session", params: { sessionID: "ses_foreignSession123" } };
    },
  };
}

test("a hire without an explicit brief delivers resolved working preferences through the real native channel once", async () => {
  const f = await fixture({ preferencesOnly: true });
  expect(f.hired.deliveryStage).toBe("consumed");
  expect(f.receivedBriefs).toHaveLength(1);
  const brief = f.receivedBriefs[0]!;
  expect(brief).toContain("Working preferences for this assignment:");
  expect(brief).toContain("Commit: owner.");
  expect(brief).toContain("Push: lead.");
  expect(brief).toContain("Release: time_rule.");
  expect(brief).toContain("After one week with changes.");
  expect(brief).toContain("Verification: review_and_seal.");
  expect(brief).toContain("Reporting style: Evidence links first.");
  expect(brief).toContain("not tool, account or machine authority");
  expect(brief).toContain("Do not run evals");
  expect(
    brief.match(/report in the resolved reporting style that the lead can act on without your transcript/gu),
  ).toHaveLength(1);
  const roster = await f.captain.serveOperatorConversation({ schemaVersion: 1, op: "roster" });
  expect(roster.op).toBe("roster");
  expect(f.receivedBriefs).toHaveLength(1);
});

test("native prepared hire survives real census/roster reconciliation and exits only its original TUI", async () => {
  const f = await fixture({ preferencesOnly: true });
  const expected = f.hired.seat;
  expect(f.pane.name).toBeDefined();
  expect(f.pane.label).toBe("Oriana Vale · tester");
  for (const title of ["OC | native-integration", "OC | Changed native task title"]) {
    f.pane.terminal_title = title;
    const roster = await f.captain.serveOperatorConversation({ schemaVersion: 1, op: "roster" });
    if (roster.op !== "roster") throw new Error("roster expected");
    expect(roster.seats).toHaveLength(2);
    const own = roster.seats.find((seat) => seat.seatId === expected.seatId);
    expect(own).toMatchObject({
      seatId: expected.seatId,
      personaId: expected.personaId,
      conversationId: expected.conversationId,
      title: "Oriana Vale",
    });
    // Census injection deliberately skips ambient enrichment in Captain tests.
    // Cross the registered native DB/enrichment boundary with those real rows.
    const observed = await readFleet({ runCommand: f.census, summaries: {} });
    const enriched = await withSeatSubagents(
      roster.seats,
      observed.seats,
      (seat) => seat.conversationId === expected.conversationId,
      undefined,
      (session) => f.sessions.subagents!(`local:${session.value}`),
    );
    const ownEnriched = enriched.find((seat) => seat.seatId === expected.seatId);
    const other = enriched.find((seat) => seat.seatId === "term_unaddressed456");
    expect(other?.subagents).toBeUndefined();
    expect(other?.conversationId).toBeUndefined();
    expect(ownEnriched?.subagents).toMatchObject({
      recent: [
        {
          id: "call_YDhIpf2dXavUjmaEQVxAtG76",
          label: "general: Lifecycle proof",
          startedAt: "2026-10-04T21:04:56.370Z",
          status: title === "OC | native-integration" ? "running" : "done",
        },
      ],
    });
    if (title === "OC | native-integration") {
      expect(ownEnriched?.subagents?.running).toBe(1);
      f.completeTask();
    } else {
      expect(ownEnriched?.subagents?.running).toBe(0);
      expect(ownEnriched?.subagents?.recent[0]?.endedAt).toBe("2026-10-04T21:06:04.419Z");
    }
  }
  expect(
    await f.captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "close_seat",
      seatId: expected.seatId,
    }),
  ).toMatchObject({ closed: true });
  expect(f.counts()).toEqual({ exitCommands: 1, physicalCloses: 0 });
  const roster = await f.captain.serveOperatorConversation({ schemaVersion: 1, op: "roster" });
  expect(roster).toMatchObject({ seats: [{ seatId: "term_unaddressed456" }] });
});

test("a switched native session cannot exit through the previously hired seat", async () => {
  const f = await fixture();
  f.switchRoute();
  expect(
    await f.captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "close_seat",
      seatId: f.hired.seat.seatId,
    }),
  ).toMatchObject({ closed: false });
  expect(f.counts()).toEqual({ exitCommands: 0, physicalCloses: 0 });
});

async function remoteFollowup(f: Awaited<ReturnType<typeof fixture>>, brief = "SSH native follow-up") {
  const result = await f.captain.serveOperatorConversation({
    schemaVersion: 1,
    op: "spawn_seat",
    conversationId: f.created.conversation.conversationId,
    seat: {
      schemaVersion: 1,
      harness: "opencode",
      title: "Oriana Vale",
      role: "tester",
      workingDirectory: f.root,
      fleet: f.ssh!.fleet.id,
      resume: f.ssh!.fleet.id + ":ses_nativeWorker123",
    },
    brief,
  });
  return result;
}

test("SSH native hire, API history and follow-up reuse the original controller without local allocation", async () => {
  const f = await fixture({ remote: true });
  const host = f.ssh!.fleet.id;
  expect(f.hired.seat.seatId).toBe(host + "/term_native123");
  expect(f.hired.control).toMatchObject({ mode: "adapter" });
  expect(f.deliveries()).toEqual({ layouts: 1, messages: 1 });
  const db = new DatabaseSync(f.database);
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    db.prepare("INSERT INTO message VALUES(?,?,?,?,?)").run(
      "msg_remoteText123",
      "ses_nativeWorker123",
      3,
      3,
      JSON.stringify({ role: "assistant", time: { created: 3, completed: 4 } }),
    );
    db.prepare("INSERT INTO part VALUES(?,?,?,?,?,?)").run(
      "prt_remoteText123",
      "msg_remoteText123",
      "ses_nativeWorker123",
      3,
      3,
      JSON.stringify({ type: "text", text: "Remote stored fixture" }),
    );
  } finally {
    db.close();
  }
  const page = await f.sessions.read(host + ":ses_nativeWorker123");
  expect(page.session).toMatchObject({ ref: host + ":ses_nativeWorker123", host, harness: "opencode" });
  expect(
    page.entries.some((entry) => entry.type === "message" && entry.text === "Remote stored fixture"),
  ).toBe(true);
  expect((await f.sessions.list({ host })).sessions).toEqual([
    expect.objectContaining({ ref: host + ":ses_nativeWorker123", host, harness: "opencode" }),
  ]);
  const reused = await remoteFollowup(f);
  expect(reused).toMatchObject({ result: { outcome: "spawned", seat: { seatId: f.hired.seat.seatId } } });
  expect(f.deliveries()).toEqual({ layouts: 1, messages: 2 });
  expect(
    f.ssh!.commands.some(
      (command) => command.includes("ControlPath=none") && command.includes("127.0.0.1:0:127.0.0.1:"),
    ),
  ).toBe(true);
  expect(f.ssh!.commands.some((command) => command.includes("opencode serve"))).toBe(false);
  const bank = await f.captain.laneToolBank("operator", f.created.conversation.conversationId);
  const message = bank.tools.find((tool) => tool.name === "message_seat")!;
  // Model native pickup at the SDK boundary, then let the real controller
  // report it to Herdr. An eternally idle fixture spends the full pickup wait.
  f.startNextPrompt();
  const receipt = await message.call({ seat: f.hired.seat.seatId, message: "Native remote message" });
  expect(receipt.isError).not.toBe(true);
  expect(JSON.parse((receipt.content[0] as { text: string }).text)).toMatchObject({
    outcome: "delivered",
    deliveryStage: "consumed",
    seatId: f.hired.seat.seatId,
    status: "working",
  });
  expect(f.reportedStates).toContain("working");
  expect(f.receivedBriefs.at(-1)).toBe("Native remote message");
  expect(f.deliveries()).toEqual({ layouts: 1, messages: 3 });
});

test("SSH native follow-up keeps its original controller while a valid Herdr reply is pending", async () => {
  const f = await fixture({ remote: true });
  await remoteFollowup(f);
  const bank = await f.captain.laneToolBank("operator", f.created.conversation.conversationId);
  const message = bank.tools.find((tool) => tool.name === "message_seat")!;
  const before = f.ssh!.transportState().filter((entry) => !entry.closed);
  const barrier = f.pauseNextReport();
  f.startNextPrompt();
  const sending = message.call({ seat: f.hired.seat.seatId, message: "Native remote message" });
  void sending.catch(() => {});
  try {
    await barrier.waiting;
    // Herdr permits ten seconds for this native request. A valid response
    // after four seconds must not retire its otherwise unchanged controller.
    await new Promise((resolve) => setTimeout(resolve, 4_250));
    const held = f.ssh!.transportState();
    barrier.resume();
    const receipt = await sending;
    const delivery = JSON.parse((receipt.content[0] as { text: string }).text);
    for (const entry of before)
      expect(held.find((current) => current.id === entry.id)).toMatchObject({ closed: false });
    expect(receipt.isError).not.toBe(true);
    expect(delivery).toMatchObject({
      outcome: "delivered",
      deliveryStage: "consumed",
      seatId: f.hired.seat.seatId,
      status: "working",
    });
    expect(f.deliveries()).toEqual({ layouts: 1, messages: 3 });
  } finally {
    barrier.resume();
    await sending.catch(() => undefined);
  }
});

test.each([
  "birth",
  "uid",
  "socket-owner",
  "disconnect",
  "retarget",
  "during-probe",
  "windows",
  "link-loss",
  "session",
])("remote %s change refuses follow-up/reuse without another writer or local fallback", async (mode) => {
  const f = await fixture({ remote: true });
  if (mode === "session") f.switchRoute();
  else f.ssh!.mutate(mode);
  const result = await remoteFollowup(f);
  expect(result).toMatchObject({ result: { outcome: "failed" } });
  if (result.op === "spawn_seat" && result.result.outcome === "failed")
    expect(result.result.detail).not.toContain("Hire from a project conversation");
  expect(f.deliveries()).toEqual({ layouts: 1, messages: 1 });
  expect(f.counts()).toEqual({ exitCommands: 0, physicalCloses: 0 });
});

test("the global operator seat hires on a linked machine only into a registered project workspace", async () => {
  // Live repro on 4b9c935f: the operator seat has no project of its own, so the remote
  // destination is proven by the owner's registration on the fleet's machine.
  const f = await fixture({ remote: true, operatorSeat: true });
  expect(f.created.conversation.scope).toEqual({ kind: "global" });
  expect(f.hired.seat.seatId).toBe(f.ssh!.fleet.id + "/term_native123");
  expect(f.deliveries()).toEqual({ layouts: 1, messages: 1 });

  const hire = (workingDirectory: string, projectId?: string) =>
    f.captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "spawn_seat",
      conversationId: f.created.conversation.conversationId,
      seat: {
        schemaVersion: 1,
        harness: "opencode",
        title: "Remote Stranger",
        workingDirectory,
        fleet: f.ssh!.fleet.id,
        ...(projectId === undefined ? {} : { projectId }),
      },
      brief: "Must not launch",
    });
  // A registered path named under another project is not re-labelled.
  expect(await hire(f.root, "home")).toMatchObject({
    result: { outcome: "failed", reason: "not_ready", detail: expect.stringContaining("does not match") },
  });
  // Once the owner's registration no longer covers this folder, nothing proves its project.
  await f.settings.update((current) => ({
    ...current,
    projects: {
      ...current.projects,
      projects: current.projects.projects.map((project) =>
        project.id === "remote-app"
          ? { ...project, workspaces: [{ ...project.workspaces[0]!, path: join(f.root, "nested") }] }
          : project,
      ),
    },
  }));
  const refused = await hire(f.root);
  expect(refused).toMatchObject({ result: { outcome: "failed", reason: "not_ready" } });
  if (refused.op !== "spawn_seat" || refused.result.outcome !== "failed") throw new Error("refusal expected");
  expect(refused.result.detail).toContain(
    `clankie project add PROJECT --workspace "${f.root}" --machine ${f.ssh!.fleet.id} --platform posix`,
  );
  expect(f.deliveries()).toEqual({ layouts: 1, messages: 1 });
  expect(f.counts()).toEqual({ exitCommands: 0, physicalCloses: 0 });
});

test("conflicting host and fleet SSH identities refuse every native history API before transport", async () => {
  const f = await fixture({ remote: true });
  const ref = f.ssh!.fleet.id + ":ses_nativeWorker123";
  await f.settings.update((current) => ({
    ...current,
    agentHosts: { connections: [{ id: f.ssh!.fleet.id, ssh: "fixture@other", shell: "posix" }] },
  }));
  const count = f.ssh!.commands.length;
  await expect(f.sessions.hosts()).rejects.toThrow("identities conflict");
  await expect(f.sessions.list()).rejects.toThrow("identities conflict");
  await expect(f.sessions.read(ref)).rejects.toThrow("identities conflict");
  await expect(f.sessions.resolve(ref)).rejects.toThrow("identities conflict");
  expect(f.ssh!.commands).toHaveLength(count);
});

test("lost native send receipt over SSH is not replayed by a repeated live-session follow-up", async () => {
  const f = await fixture({ remote: true });
  f.loseSend();
  expect(await remoteFollowup(f)).toMatchObject({ result: { outcome: "failed" } });
  expect(await remoteFollowup(f)).toMatchObject({ result: { outcome: "failed" } });
  expect(f.deliveries()).toEqual({ layouts: 1, messages: 2 });
});

test("stored remote history grants no cold controller adoption, and unknown hosts do not read local history", async () => {
  const f = await fixture({ remote: true });
  const ref = f.ssh!.fleet.id + ":ses_nativeWorker123";
  f.ssh!.mutate("link-loss");
  expect(await f.sessions.read(ref)).toMatchObject({ session: { ref, harness: "opencode" } });
  await expect(f.sessions.read("unknown:ses_nativeWorker123")).rejects.toThrow("Unknown remote");
  expect(await remoteFollowup(f)).toMatchObject({ result: { outcome: "failed" } });
  expect(f.deliveries()).toEqual({ layouts: 1, messages: 1 });
});

test("history-first native hire keeps Captain admission during a prepare drop and return", async () => {
  // Cache admission is independent of concurrent project role journal writes.
  const f = await fixture({ remote: true, historyFirst: true, assignRole: false });
  const ssh = f.ssh!;
  const before = ssh.operations.length;
  ssh.onNextDiscover(async () => {
    ssh.mutate("disconnect");
    await f.captain.serveOperatorConversation({ schemaVersion: 1, op: "roster" });
    ssh.mutate("reconnect");
  });
  const result = await f.captain.serveOperatorConversation({
    schemaVersion: 1,
    op: "spawn_seat",
    conversationId: f.created.conversation.conversationId,
    seat: {
      schemaVersion: 1,
      harness: "opencode",
      title: "Oriana Vale",
      role: "tester",
      workingDirectory: f.root,
      fleet: ssh.fleet.id,
    },
    brief: "Must not allocate after observed loss",
  });
  expect(result).toMatchObject({ result: { outcome: "failed" } });
  const after = ssh.operations.slice(before);
  expect(after).toContain("discover");
  expect(after).not.toContain("allocate");
  expect(after).not.toContain("configure");
  expect(f.deliveries()).toEqual({ layouts: 1, messages: 1 });
});

test("Captain-first history works after a reconnect without adopting its old controller", async () => {
  const f = await fixture({ remote: true, assignRole: false });
  const ssh = f.ssh!;
  const ref = ssh.fleet.id + ":ses_nativeWorker123";
  // Warm history after Captain, the other ordering that formerly reused its guard.
  expect(await f.sessions.read(ref)).toMatchObject({ session: { ref } });
  ssh.mutate("disconnect");
  await f.captain.serveOperatorConversation({ schemaVersion: 1, op: "roster" });
  ssh.mutate("reconnect");
  expect(await remoteFollowup(f)).toMatchObject({ result: { outcome: "failed" } });
  expect(await f.sessions.read(ref)).toMatchObject({ session: { ref, harness: "opencode" } });
  expect((await f.sessions.list({ host: ssh.fleet.id })).sessions).toContainEqual(
    expect.objectContaining({ ref }),
  );
  expect(f.deliveries()).toEqual({ layouts: 1, messages: 1 });
});

test("advancing a fleet revision closes and evicts the old helper and SSH forward", async () => {
  const f = await fixture({ remote: true, historyFirst: true, assignRole: false });
  const ssh = f.ssh!;
  const old = ssh.workers.forFleet(ssh.fleet, async () => {}, 0);
  const owned = ssh.transportState();
  expect(owned.some((entry) => entry.kind === "helper" && !entry.closed)).toBe(true);
  expect(owned.some((entry) => entry.kind === "forward" && !entry.closed)).toBe(true);
  ssh.workers.forFleet(ssh.fleet, async () => {}, 1);
  for (const entry of owned)
    expect(ssh.transportState().find((current) => current.id === entry.id)).toMatchObject({ closed: true });
  await expect(old.list()).rejects.toThrow("retired");
  expect(() => ssh.workers.forFleet(ssh.fleet, async () => {}, 0)).toThrow("revision");
  const ref = ssh.fleet.id + ":ses_nativeWorker123";
  expect(await f.sessions.read(ref)).toMatchObject({ session: { ref } });
  expect(f.counts()).toEqual({ exitCommands: 0, physicalCloses: 0 });
});
