import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { Transform } from "node:stream";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";

// Only the OS/container namespace and kernel capability evidence are fixtures.
// The generated controller proxy is genuine Node code; no native agent, Docker,
// account probe, provider request or benchmark is executed.
const namespace = vi.hoisted(() => ({ root: "" }));
vi.mock("../../../scripts/evals/lead-native-capability.mjs", () => ({
  nativeRuntimeEvidence: () => ({ binaries: { "/opt/codex/bin/codex": "c".repeat(64) } }),
  assertNativeRuntimeCapability: async () => {
    throw Error("No live capability in fixture");
  },
}));
vi.mock("../../../scripts/evals/lead-native-proxy-build.mjs", async (original) => {
  const actual = await original<any>();
  return {
    buildNativeProxy: (input: any) =>
      actual.buildNativeProxy({
        ...input,
        upstream: join(namespace.root, "rpc.sock"),
        socketPath: join(namespace.root, "tui.sock"),
      }),
  };
});
// @ts-expect-error -- manual checkout-only ESM runner.
import { createNativeFleet } from "../../../scripts/evals/lead-native-runtime.mjs";
// @ts-expect-error -- manual checkout-only ESM runner.
import { NativeOwnerAttachment } from "../../../scripts/evals/lead-native-attachment.mjs";
// @ts-expect-error -- manual checkout-only ESM runner.
import { nativePermissionProfile } from "../../../scripts/evals/lead-native-policy.mjs";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const cwd = "/eval/tasks/one";
const accountId = "fixture-account";
const threadId = "fixture-root";
const accountEmail = "fixture@example.invalid";
const model = "fixture-model";
const config = () => ({
  approval_policy: "never",
  mcp_servers: {},
  features: { multi_agent: false },
  web_search: "disabled",
  default_permissions: "lead_eval",
  permissions: { lead_eval: nativePermissionProfile(cwd) },
});
function processFixture() {
  return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn() });
}
async function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "native-hire-"));
  namespace.root = root;
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const hostCwd = join(root, "tasks/one");
  mkdirSync(join(hostCwd, ".git"), { recursive: true, mode: 0o700 });
  const accountHome = join(root, "control/one/auth");
  mkdirSync(accountHome, { recursive: true, mode: 0o700 });
  writeFileSync(join(accountHome, "auth.json"), "{}", { mode: 0o600 });
  const calls: Array<{ method: string; params: any }> = [];
  const launches: string[][] = [];
  const resetsAt = Math.floor(Date.now() / 1000) + 10000;
  let loaded = false,
    reported = false,
    wrongProfile = false;
  const sockets = new Set<WebSocket>();
  const provider = new WebSocketServer({ path: "/", server: undefined, noServer: true });
  const { createServer } = await import("node:http");
  const http = createServer();
  http.on("upgrade", (request, socket, head) =>
    provider.handleUpgrade(request, socket, head, (ws) => provider.emit("connection", ws, request)),
  );
  http.listen(join(root, "rpc.sock"));
  await once(http, "listening");
  cleanup.push(async () => {
    for (const socket of sockets) socket.terminate();
    provider.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  provider.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString());
      calls.push(request);
      if (request.id === undefined) return;
      let result: any = {};
      switch (request.method) {
        case "config/read":
          result = {
            config: config(),
            origins: {},
            layers: [{ name: { type: "sessionFlags" }, version: "fixture", config: config() }],
          };
          break;
        case "account/read":
          result = { account: { type: "chatgpt", email: accountEmail } };
          break;
        case "account/rateLimits/read":
          result = {
            accountId,
            ordinaryUsageAllowed: true,
            rateLimitsByLimitId: {
              codex: {
                spendControlReached: false,
                primary: { windowDurationMins: 300, usedPercent: 1, resetsAt: resetsAt },
                secondary: { windowDurationMins: 10080, usedPercent: 1, resetsAt: resetsAt },
              },
            },
          };
          break;
        case "thread/loaded/list":
          result = { data: loaded ? [threadId] : [] };
          break;
        case "thread/list":
          result = {
            data: loaded && !request.params.archived ? [{ id: threadId, cwd }] : [],
            nextCursor: null,
          };
          break;
        case "thread/read":
          result = { thread: { id: threadId, cwd, turns: [] } };
          break;
        case "thread/resume":
          result = { thread: { id: threadId, cwd, turns: [] } };
          break;
        case "thread/start":
          loaded = true;
          result = {
            thread: { id: threadId, cwd },
            cwd,
            model,
            reasoningEffort: "medium",
            modelProvider: "openai",
            approvalPolicy: "never",
            approvalsReviewer: "user",
            activePermissionProfile: { id: wrongProfile ? "unsafe" : "lead_eval" },
            runtimeWorkspaceRoots: [cwd],
          };
          break;
        case "turn/start":
          result = { turn: { id: "fixture-turn" } };
          break;
      }
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  let native: WebSocket | undefined;
  const nativeRequest = (message: any) =>
    new Promise<any>((resolve, reject) => {
      const receive = (bytes: WebSocket.RawData) => {
        const value = JSON.parse(bytes.toString());
        if (value.id === message.id) {
          native!.off("message", receive);
          resolve(value);
        }
      };
      native!.on("message", receive);
      native!.once("error", reject);
      native!.send(JSON.stringify(message));
    });
  const owner = processFixture();
  let proxy: ReturnType<typeof spawn> | undefined;
  let relay: ReturnType<typeof processFixture> | undefined;
  const container: any = {
    root,
    id: "a".repeat(64),
    capability: {},
    stopped: false,
    inspect: vi.fn(async () => ({})),
    attach: vi.fn(async () => owner),
    stop: vi.fn(async () => {
      container.stopped = true;
    }),
    exec: vi.fn(async (argv: string[]) => {
      launches.push(argv);
      if (argv.includes("/usr/bin/python3"))
        return JSON.stringify([
          { inode: 100, peer: 200, state: 1, type: 1 },
          { inode: 200, peer: 100, state: 1, type: 1, path: "/eval/control/herdr-client.sock" },
          { inode: 300, peer: 400, state: 1, type: 1 },
          { inode: 400, peer: 300, state: 1, type: 1, path: "/eval/control/one/tui.sock" },
        ]);
      const script = argv[argv.indexOf("-e") + 1];
      if (argv.includes("-e") && script?.includes("/proc"))
        return JSON.stringify([
          { pid: 10, startTicks: "100", socketInodes: [script.includes("expectedHash") ? 100 : 300] },
        ]);
      const index = argv.indexOf("herdr");
      if (index < 0) return "";
      const args = argv.slice(index + 1);
      if (args[0] === "tab" && args[1] === "create")
        return JSON.stringify({ result: { root_pane: { pane_id: "w1:p1" } } });
      if (args[0] === "agent" && args[1] === "start") {
        native = new WebSocket(`ws+unix://${join(root, "tui.sock")}:/`);
        await once(native, "open");
        await nativeRequest({
          id: 100,
          method: "initialize",
          params: {
            clientInfo: { name: "codex-tui", version: "fixture", title: null },
            capabilities: {
              experimentalApi: true,
              requestAttestation: false,
              optOutNotificationMethods: null,
            },
          },
        });
        const request = nativeRequest({
          id: 101,
          method: "thread/start",
          params: {
            cwd,
            sandbox: "workspace-write",
            runtimeWorkspaceRoots: [],
            approvalPolicy: "never",
            approvalsReviewer: "user",
            config: {
              default_permissions: "lead_eval",
              features: { multi_agent: false },
              permissions: { lead_eval: nativePermissionProfile(cwd) },
              web_search: "disabled",
            },
          },
        });
        // An invalid response intentionally loses the proxy instead of reaching the TUI.
        if (!wrongProfile) await request;
        else void request.catch(() => {});
        return "";
      }
      if (args[0] === "pane" && args[1] === "report-agent") reported = args.includes(threadId);
      return JSON.stringify({
        result: {
          agent: {
            pane_id: "w1:p1",
            terminal_id: "fixture-terminal",
            agent: "codex",
            agent_status: "idle",
            cwd,
            ...(reported ? { agent_session: { kind: "id", source: "herdr:codex", value: threadId } } : {}),
          },
        },
      });
    }),
    pipe: async (argv: string[]) => {
      if (argv.at(-1)?.endsWith("proxy.mjs")) {
        proxy = spawn(process.execPath, [join(root, "control/one/proxy.mjs")], {
          env: { PATH: process.env.PATH },
          stdio: ["pipe", "pipe", "pipe"],
        });
        // The disposable fixture namespace maps only the control socket path.
        let buffered = "";
        const stdout = new Transform({
          transform(chunk, _encoding, done) {
            buffered += chunk.toString();
            let end;
            while ((end = buffered.indexOf("\n")) >= 0) {
              const line = buffered.slice(0, end);
              buffered = buffered.slice(end + 1);
              const frame = JSON.parse(line);
              if (frame.ready) frame.socketPath = "/eval/control/one/tui.sock";
              this.push(JSON.stringify(frame) + "\n");
            }
            done();
          },
        });
        proxy.stdout!.pipe(stdout);
        const child = Object.assign(new EventEmitter(), {
          stdin: proxy.stdin!,
          stdout,
          kill: () => proxy?.kill(),
        });
        proxy.once("exit", (...args) => child.emit("exit", ...args));
        proxy.once("error", (error) => child.emit("error", error));
        return child;
      }
      const socket = createConnection(join(root, "rpc.sock"));
      await once(socket, "connect");
      relay = processFixture();
      Object.assign(relay, { stdin: socket, stdout: socket, kill: () => socket.destroy() });
      cleanup.push(() => {
        socket.destroy();
      });
      return relay;
    },
  };
  cleanup.push(async () => {
    native?.terminate();
    proxy?.kill();
    if (proxy && proxy.exitCode === null && proxy.signalCode === null) await once(proxy, "exit");
  });
  const attachment = new NativeOwnerAttachment(container, { herdrSha256: "b".repeat(64) });
  await attachment.attach();
  const fleet = createNativeFleet({
    container,
    ownerAttachment: attachment,
    allocations: [
      {
        hostCwd,
        containerCwd: cwd,
        accountHome,
        accountId,
        accountLabel: "fixture",
        email: accountEmail,
        model,
        effort: "medium",
      },
    ],
  });
  const accounts = vi.fn(async () => {
    throw Error("Host account probe must never run");
  });
  const store = new HerdrWatchStore(join(root, "watches.json"), {
    runner: fleet.captainOptions.nativeHerdrRunner,
    seatAdapters: fleet.captainOptions.seatAdapters,
    nativeLaunchPolicy: fleet.captainOptions.nativeLaunchPolicy,
    codexAccounts: accounts,
  });
  cleanup.push(() => store.close());
  return {
    root,
    fleet,
    container,
    calls,
    launches,
    accounts,
    owner,
    emit: (event: any) => {
      for (const socket of sockets)
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
    },
    relay: () => relay!,
    proxy: () => proxy!,
    wrongProfile: () => {
      wrongProfile = true;
    },
    hire: () =>
      store.spawnSeat(
        {
          schemaVersion: 1,
          harness: "codex",
          workingDirectory: hostCwd,
          title: "fixture",
          account: "fixture",
          model,
          effort: "medium",
          skills: "plain",
        },
        undefined,
        "Implement the fixture task",
      ),
  };
}
it("hires through the real store/adapter/proxy and binds exact effective profile before the brief", async () => {
  const f = await fixture();
  const result = await f.hire();
  expect(result).toMatchObject({ outcome: "spawned" });
  expect(f.accounts).not.toHaveBeenCalled();
  expect(f.calls.find((call) => call.method === "thread/start")?.params.permissions).toBe("lead_eval");
  expect(f.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
  expect(f.launches.find((args) => args.includes("tab"))?.includes(cwd)).toBe(true);
  expect(
    f.launches.find((args) => args.includes("start"))?.includes("unix:///eval/control/one/tui.sock"),
  ).toBe(true);
  expect(readFileSync(join(f.root, "control/one/bin/codex"), "utf8")).toContain("HERDR_PANE_ID");
  expect(f.fleet.slots[0].runtime.ledger.result().complete).toBe(false);
  expect(
    await f.fleet.captainOptions.nativeHerdrRunner.transcript({
      session: { kind: "path", value: "/owner/never-read" },
    }),
  ).toBeUndefined();
  f.emit({ method: "turn/started", params: { threadId, turn: { id: "fixture-turn" } } });
  f.emit({
    method: "thread/tokenUsage/updated",
    params: {
      threadId,
      turnId: "fixture-turn",
      tokenUsage: {
        total: {
          totalTokens: 12,
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 2,
          reasoningOutputTokens: 1,
        },
      },
    },
  });
  f.emit({
    method: "turn/completed",
    params: { threadId, turn: { id: "fixture-turn", status: "completed" } },
  });
  await vi.waitFor(() =>
    expect(f.fleet.slots[0].runtime.ledger.result()).toMatchObject({ complete: true, totalTokens: 12 }),
  );
  f.emit({ method: "turn/started", params: { threadId, turn: { id: "second-turn" } } });
  await vi.waitFor(() =>
    expect(f.fleet.slots[0].runtime.ledger.result()).toMatchObject({
      valid: true,
      complete: false,
      totalTokens: null,
    }),
  );
  f.owner.emit("exit", 1);
  await vi.waitFor(() => expect(f.container.stop).toHaveBeenCalled());
});

for (const loss of ["proxy", "audit", "unknown-thread"] as const) {
  it(`stops the exact boundary when ${loss} coverage is lost after a real fixture hire`, async () => {
    const f = await fixture();
    expect(await f.hire()).toMatchObject({ outcome: "spawned" });
    expect(f.container.stop).not.toHaveBeenCalled();
    if (loss === "proxy") f.proxy().kill();
    else if (loss === "audit") f.relay().emit("exit", 1);
    else f.emit({ method: "turn/started", params: { threadId: "unadmitted", turn: { id: "bad" } } });
    await vi.waitFor(() => expect(f.container.stop).toHaveBeenCalled());
    expect(f.container.stopped).toBe(true);
    expect(f.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
  });
}
it("refuses an effective-profile mismatch before sending the initial brief", async () => {
  const f = await fixture();
  f.wrongProfile();
  const result = await f.hire();
  expect(result).toMatchObject({ outcome: "failed" });
  expect(f.container.stop).toHaveBeenCalled();
  expect(f.calls.some((call) => call.method === "turn/start")).toBe(false);
});
