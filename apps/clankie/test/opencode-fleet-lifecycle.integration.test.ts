import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createOpenCodeNativeHost } from "../src/captain/opencode-native-host.ts";
import { createOpenCodeSeatAdapter } from "../src/captain/opencode-seat-adapter.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { readFleet } from "../src/captain/herdr-census.ts";
import { withSeatSubagents } from "../src/captain/seat-subagents.ts";
import { createAgentSessions } from "../src/agent-sessions.ts";
import { OpenCodeProfiles } from "../src/opencode-profiles.ts";
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

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "opencode-fleet-integration-")));
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
      session: { permission: () => [], question: () => [], status: () => ({ type: "idle" }) },
    },
    client: {
      session: {
        async create() {
          await writeOpenCodeNativeSession(database, root, sessionId);
          return { data: { id: sessionId } };
        },
        get: async () => ({ data: { id: sessionId, directory: root } }),
        status: async () => ({ data: {} }),
        messages: async () => ({ data: [] }),
        promptAsync: async () => ({ response: { status: 204 } }),
      },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
    },
  };
  cleanups.push(async () => dispose());
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
        });
      if (args.includes("cwd")) return `p${process.pid}\nn${root}\n`;
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
    request: async (_binding, method, input) => {
      const params = input as Record<string, unknown>;
      if (method === "layout.apply") {
        expect(params.workspace_id).toBe("w1");
        expect(params.tab_label).toBe("Oriana Vale · tester");
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
    },
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
              ...(present ? [{ tab_id: "w1:t2", workspace_id: "w1", label: "Oriana Vale · tester" }] : []),
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
    if (args[0] === "pane" && args[1] === "close") {
      physicalCloses++;
      throw new Error("Unconditional pane close forbidden");
    }
    throw new Error(`Unsupported Herdr fixture command ${args.join(" ")}`);
  };
  const runner = createHerdrWatchRunner(undefined, herdr, native.createCommandTab);
  const adapter = createOpenCodeSeatAdapter({
    repoRoot: fileURLToPath(new URL("../../../", import.meta.url)),
    stateDir: state,
    native,
    discover: async () => ({ executable, version: "1.18.18" }),
    timeoutMs: 3000,
  });
  const settings = new SettingsStore(join(root, "settings.json"));
  const sessions = createAgentSessions(settings, undefined, new OpenCodeProfiles(state));
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
    mcp: { catalog: unused, call: unused },
    email: { list: unused, read: unused, search: unused, send: unused },
    browser: { catalog: unused, call: unused },
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
    seatAdapters: [adapter],
    nativeHerdrRunner: runner,
    nativeCensusRunner: census,
  });
  cleanups.push(() => captain.close());
  const created = await captain.serveOperatorConversation({
    schemaVersion: 1,
    op: "create",
    scope: { kind: "global" },
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
      role: "tester",
      workingDirectory: root,
    },
    brief: "Fixture native brief",
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
    database,
    root,
    completeTask,
    counts: () => ({ exitCommands, physicalCloses }),
    switchRoute: () => {
      route = { name: "session", params: { sessionID: "ses_foreignSession123" } };
    },
  };
}

test("native prepared hire survives real census/roster reconciliation and exits only its original TUI", async () => {
  const f = await fixture();
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
