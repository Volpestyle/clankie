import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import {
  readFleet,
  occupantIdForHerdrSession,
  recoverLocalCodexSession,
  recoverLocalCodexParent,
  type HerdrCensusRunner,
} from "../src/captain/herdr-census.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";

const roots: string[] = [];
const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((close) => close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// Native replies are grounded in the Oct 4 reattach: a foreground Codex resume,
// a detached --listen server, and Codex 0.160's aliased private socket. The test
// crosses the durable-record, native-observation and fleet/watch API boundaries.
async function fixture(legacy = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codex-census-")));
  roots.push(root);
  await mkdir(join(root, "daemon"));
  const nativeSocket = join(root, "daemon", "socket");
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  http.listen(nativeSocket);
  await once(http, "listening");
  servers.push(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => http.close(() => resolve())));
  });
  const socket = join(root, "rpc.sock");
  await symlink(nativeSocket, socket);
  const endpoint = `unix://${socket}`;
  const path = join(root, "seats.json");
  const binding = { runtime: "external" as const, socketPath: "/trusted/herdr.sock", session: "default" };
  const session = {
    source: "herdr:codex",
    kind: "id" as const,
    value: "01a109f1-e63d-71b1-813a-1168c8648e0b",
  };
  let loadedThread = session.value;
  let extraThread: "child" | "independent" | undefined;
  const state = { holdLoaded: false, requests: [] as string[], closed: 0 };
  server.on("connection", (socket) => {
    socket.once("close", () => {
      state.closed++;
    });
    socket.on("message", (bytes) => {
      const request = JSON.parse(String(bytes)) as {
        id?: number;
        method: string;
        params?: { threadId?: string };
      };
      state.requests.push(request.method);
      if (request.method === "thread/loaded/list" && state.holdLoaded) return;
      if (request.id !== undefined)
        socket.send(
          JSON.stringify({
            id: request.id,
            result:
              request.method === "thread/loaded/list"
                ? { data: [loadedThread, ...(extraThread ? ["parallel-thread"] : [])] }
                : request.method === "thread/read"
                  ? {
                      thread: {
                        id: request.params?.threadId,
                        parentThreadId: extraThread === "child" ? loadedThread : null,
                      },
                    }
                  : {},
          }),
        );
    });
  });
  const start = "Sun Oct  4 21:43:29 2026";
  const launch = {
    pid: 20145,
    pane: "w2H:p8R",
    binding,
    start,
    nativeOccupantId: occupantIdForHerdrSession(session),
    ...(legacy ? {} : { threadId: session.value, endpoint }),
  };
  await writeFile(path, JSON.stringify({ version: 1, seats: [launch] }));
  const agent = {
    pane_id: launch.pane,
    terminal_id: "term_65d0ed8ca1b1723",
    agent: "codex",
    agent_status: "idle",
    name: "pell-f996",
  };
  let argv = ["codex", "--remote", endpoint, "resume", session.value];
  let serverStart = start;
  let socketOwner = nativeSocket;
  let foreground = 20803;
  let revoke = false;
  let probes = 0;
  const run: HerdrCensusRunner = async (command, args) => {
    let stdout = "";
    if (command === "herdr") {
      if (args[0] === "agent" && args[1] === "list") stdout = JSON.stringify({ result: { agents: [agent] } });
      else if (args[0] === "pane" && args[1] === "list")
        stdout = JSON.stringify({ result: { panes: [agent] } });
      else if (args[0] === "agent" && args[1] === "get") stdout = JSON.stringify({ result: { agent } });
      else if (args[0] === "pane" && args[1] === "process-info") {
        probes++;
        if (revoke && probes > 1) await writeFile(path, JSON.stringify({ version: 1, seats: [] }));
        stdout = JSON.stringify({
          result: {
            process_info: {
              pane_id: launch.pane,
              shell_pid: 15734,
              foreground_process_group_id: foreground,
              foreground_processes: [{ pid: foreground, argv, name: "codex" }],
            },
          },
        });
      } else stdout = JSON.stringify({ result: { snapshot: { panes: [] } } });
    } else if (command === "/bin/ps") {
      stdout =
        args.at(-1) === "command="
          ? `codex -c mcp_servers.clankie.enabled=true app-server --listen ${endpoint}`
          : `${args[1] === String(launch.pid) ? serverStart : start} codex\n`;
    } else if (command === "/usr/sbin/lsof") stdout = `p20145\nn${socketOwner}\n`;
    else throw new Error(`Unexpected observation ${command} ${args.join(" ")}`);
    return { stdout, stderr: "" };
  };
  return {
    state,
    path,
    run,
    binding,
    session,
    launch,
    agent,
    options: {
      runCommand: run,
      localCodexRecordsPath: path,
      bridgeSocket: binding.socketPath,
      herdrSession: binding.session,
    },
    change: (field: string) => {
      if (field === "loaded-thread") loadedThread = "different-live-thread";
      if (field === "child") extraThread = "child";
      if (field === "independent") extraThread = "independent";
      if (field === "thread") argv = ["codex", "--remote", endpoint, "resume", "different-thread"];
      if (field === "endpoint") argv = ["codex", "--remote", `${endpoint}-other`, "resume", session.value];
      if (field === "lifetime") serverStart = "Sun Oct  4 21:43:30 2026";
      if (field === "socket-owner") socketOwner = join(root, "another-socket");
      if (field === "shell") foreground = 15734;
      if (field === "native") argv = ["bash", "--remote", endpoint, "resume", session.value];
      if (field === "revoked") revoke = true;
    },
  };
}

it.each([false, true])(
  "recovers the private resumed native thread across roster and watch lookups (legacy record: %s)",
  async (legacy) => {
    const f = await fixture(legacy);
    const fleet = await readFleet({ ...f.options, summaries: {} });
    expect(fleet.seats).toHaveLength(1);
    expect(fleet.seats[0]).toMatchObject({
      paneId: f.launch.pane,
      session: f.session,
      occupantId: f.launch.nativeOccupantId,
    });
    const runner = createHerdrWatchRunner(
      undefined,
      async (args) => (await f.run("herdr", args)).stdout,
      undefined,
      {
        localCodexRecordsPath: f.path,
        localCodexBinding: async () => f.binding,
        runLocalCommand: f.run,
      },
    );
    expect((await runner.get(f.launch.pane)).session).toEqual(f.session);
    expect((await runner.list?.())?.[0]?.session).toEqual(f.session);
    expect((await runner.resolveTerminal(f.agent.terminal_id))?.session).toEqual(f.session);
  },
);

it.each([
  "thread",
  "loaded-thread",
  "independent",
  "endpoint",
  "lifetime",
  "socket-owner",
  "shell",
  "native",
  "revoked",
])("does not recover a stale or mismatched %s proof", async (field) => {
  const f = await fixture();
  f.change(field);
  expect(
    await recoverLocalCodexSession({ paneId: f.launch.pane, agent: "codex" }, f.options),
  ).toBeUndefined();
  expect((await readFleet({ ...f.options, summaries: {} })).seats).toEqual([]);
});

it("closes the owned recovery socket on cancellation and skips later authority observations", async () => {
  const f = await fixture();
  const controller = new AbortController();
  f.state.holdLoaded = true;
  const commands: string[] = [];
  const run: HerdrCensusRunner = (command, args) => {
    commands.push(`${command} ${args.join(" ")}`);
    return f.run(command, args);
  };
  const pending = recoverLocalCodexSession(
    { paneId: f.launch.pane, agent: "codex" },
    {
      ...f.options,
      runCommand: run,
      signal: controller.signal,
    },
  );
  // Attach rejection handling before abort so the test never abandons an owned request.
  const outcome = pending.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const deadline = Date.now() + 2_000;
  while (!f.state.requests.includes("thread/loaded/list")) {
    if (Date.now() >= deadline) throw new Error("Recovery fixture did not reach loaded-thread read");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const observed = commands.length;
  controller.abort(new Error("fixture cancellation"));
  expect(await outcome).toEqual({ error: controller.signal.reason });
  while (f.state.closed === 0) {
    if (Date.now() >= deadline) throw new Error("Cancelled owned recovery socket did not close");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(f.state.requests).toEqual(["initialize", "initialized", "thread/loaded/list"]);
  expect(commands).toHaveLength(observed);
});

it("keeps a resumed root steerable when its native parallel child remains loaded", async () => {
  const f = await fixture();
  f.change("child");
  expect(await recoverLocalCodexSession({ paneId: f.launch.pane, agent: "codex" }, f.options)).toEqual(
    f.session,
  );
});

it("does not borrow a launch from a different selected Herdr binding", async () => {
  const f = await fixture();
  expect(
    await recoverLocalCodexSession(
      { paneId: f.launch.pane, agent: "codex" },
      { ...f.options, bridgeSocket: "/other/herdr.sock" },
    ),
  ).toBeUndefined();
  expect(
    await recoverLocalCodexSession(
      { paneId: f.launch.pane, agent: "codex" },
      { ...f.options, herdrSession: "other" },
    ),
  ).toBeUndefined();
});

it("recovers a recorded parent edge only while its exact native occupant remains", async () => {
  const f = await fixture();
  const parentSession = {
    source: "herdr:claude",
    kind: "id" as const,
    value: "6ab6b3da-bfd6-4dfe-b73f-d4a7d0930ee1",
  };
  const parent = { paneId: "w3Z:p2N", occupantId: occupantIdForHerdrSession(parentSession) };
  await writeFile(f.path, JSON.stringify({ version: 1, seats: [{ ...f.launch, parent }] }));
  let current = parentSession.value;
  const run: HerdrCensusRunner = async (command, args) =>
    command === "herdr" && args[0] === "agent" && args[1] === "get" && args[2] === parent.paneId
      ? {
          stdout: JSON.stringify({
            result: {
              agent: {
                pane_id: parent.paneId,
                agent: "claude",
                agent_session: { ...parentSession, value: current },
              },
            },
          }),
          stderr: "",
        }
      : f.run(command, args);
  const entry = { paneId: f.launch.pane, agent: "codex", session: f.session };
  expect(await recoverLocalCodexParent(entry, { ...f.options, runCommand: run })).toBe(parent.paneId);
  expect((await readFleet({ ...f.options, runCommand: run, summaries: {} })).seats[0]?.parentPaneId).toBe(
    parent.paneId,
  );
  current = "replacement-session";
  expect(await recoverLocalCodexParent(entry, { ...f.options, runCommand: run })).toBeUndefined();
  expect((await readFleet({ ...f.options, runCommand: run, summaries: {} })).seats[0]).not.toHaveProperty(
    "parentPaneId",
  );
});
