/** Manual-only native transport. Importing never starts a service, agent or container. */
import { Duplex } from "node:stream";
import { mkdirSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { openCodexSocket } from "../../apps/clankie/src/captain/codex-app-server.ts";
import { createCodexSeatAdapter } from "../../apps/clankie/src/captain/codex-seat-adapter.ts";
import { createHerdrWatchRunner } from "../../apps/clankie/src/captain/herdr-watch.ts";
import {
  nativePermissionConfig,
  nativePermissionProfile,
  validateNativeLaunchState,
  validateEffectiveNativeConfig,
} from "./lead-native-policy.mjs";
import { isDeepStrictEqual } from "node:util";
import { NativeProxyController, NativeRequestPolicy } from "./lead-native-proxy.mjs";
import { buildNativeProxy } from "./lead-native-proxy-build.mjs";
import { nativeRuntimeEvidence } from "./lead-native-capability.mjs";
import { NativeOwnerAttachment, nativeTuiBinding } from "./lead-native-attachment.mjs";
import { CodexAccountSource, NativeBudgetGuard, NativeUsageLedger } from "./lead-native-ledger.mjs";
const CODEX = "/opt/codex/bin/codex";
const NODE = "/usr/local/bin/node";
const HERDR_SOCKET = "/eval/control/herdr.sock";
const clean = (environment, argv) => [
  "/usr/bin/env",
  "-i",
  ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
  ...argv,
];

export { nativePermissionConfig } from "./lead-native-policy.mjs";

/** Writes a controller-owned native executable wrapper, not a shell prompt/brief. */
export function writeNativeWrapper(path, environment, config, endpoint, { paneId, model, effort }) {
  if (!/^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/u.test(paneId)) throw Error("Exact native pane identity required");
  const args = [
    ...config.flatMap((value) => ["-c", value]),
    "--remote",
    endpoint,
    "--model",
    model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(effort)}`,
  ];
  const parent = realpathSync(dirname(path));
  if (parent !== dirname(path)) throw Error("Noncanonical wrapper directory");
  const stat = lstatSync(parent);
  if (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
    throw Error("Wrapper directory is not private");
  const script =
    `#!${NODE}\nimport { spawn } from "node:child_process";\n` +
    `const args=process.argv.slice(2);if(JSON.stringify(args)!==${JSON.stringify(JSON.stringify(args))})throw Error("Only the exact allocated interactive native argv is allowed");\n` +
    `if(process.env.HERDR_PANE_ID!==${JSON.stringify(paneId)})throw Error("Native pane identity changed");const child=spawn(${JSON.stringify(CODEX)},args,{env:${JSON.stringify({ ...environment, HERDR_PANE_ID: paneId })},stdio:"inherit"});\n` +
    'child.on("error",()=>process.exit(1));child.on("exit",(code)=>process.exit(code??1));\n';
  writeFileSync(path, script, { flag: "wx", mode: 0o500 });
}

/** One allocated root; arbitrary descendants and resuming other roots are refused. */
export function createNativeRuntime({ container, allocation, ownerAttachment, now = Date.now }) {
  const { hostCwd, containerCwd, accountHome, accountId, email, accountLabel, model, effort } = allocation;
  if (!hostCwd || realpathSync(hostCwd) !== hostCwd || !accountId || !email || !accountLabel)
    throw Error("Exact controller allocation required");
  const rel = relative(container.root, hostCwd);
  if (rel.startsWith("..") || containerCwd !== `/eval/${rel}`)
    throw Error("Host/container workspace mapping mismatch");
  const config = nativePermissionConfig(containerCwd);
  const control = join(container.root, "control");
  mkdirSync(control, { mode: 0o700, recursive: true });
  mkdirSync(join(control, "home"), { mode: 0o700, recursive: true });
  const key = containerCwd.split("/").at(-1);
  const slot = join(control, key);
  mkdirSync(slot, { mode: 0o700, recursive: true });
  if (
    realpathSync(slot) !== slot ||
    lstatSync(slot).uid !== process.getuid() ||
    (lstatSync(slot).mode & 0o077) !== 0
  )
    throw Error("Unowned protected native slot");
  mkdirSync(join(slot, "bin"), { mode: 0o700 });
  mkdirSync(join(slot, "home"), { mode: 0o700 });
  if (accountHome !== join(slot, "auth")) throw Error("Credential allocation is outside its protected slot");
  const environment = Object.freeze({
    PATH: `/eval/control/${key}/bin:/usr/local/bin:/usr/bin:/bin`,
    HOME: `/eval/control/${key}/home`,
    CODEX_HOME: `/eval/control/${key}/auth`,
    HERDR_SOCKET_PATH: HERDR_SOCKET,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
  });
  const upstream = `/eval/control/${key}/rpc.sock`;
  const proxyPath = `/eval/control/${key}/tui.sock`;
  const endpoint = `unix://${proxyPath}`;
  const profile = nativePermissionProfile(containerCwd);
  const hostProtocol = new NativeRequestPolicy({
    allocationId: key,
    cwd: containerCwd,
    profile,
    model,
    effort,
  });
  const pendingRequests = new Map();
  let proxyController;
  let pendingRoot;
  let rootReadyResolve;
  let rootReadyReject;
  const rootReady = new Promise((resolve, reject) => {
    rootReadyResolve = resolve;
    rootReadyReject = reject;
  });
  void rootReady.catch(() => {});
  let activeTurn;
  let activePolicy;

  const ledger = new NativeUsageLedger();
  const abort = new AbortController();
  let rootSession;
  let boundPane;
  let monitor;
  let monitorFailure;
  let source;
  let trustedRead;
  const configuration = async () => {
    if (!trustedRead) throw Error("Trusted native configuration channel unavailable");
    const proof = await validateEffectiveNativeConfig(
      await trustedRead.request("config/read", { includeLayers: true, cwd: containerCwd }),
      { cwd: containerCwd, codexHome: environment.CODEX_HOME },
    );
    ledger.record("configuration", proof);
  };
  let onServerFailure;
  const guard = new NativeBudgetGuard({
    accounts: [accountId],
    now,
    stop: (reason) => container.stop(reason),
  });
  const checkOwner = async () => {
    // This is a controller-owned live attachment port, never an imported JSON claim.
    if (
      !(ownerAttachment instanceof NativeOwnerAttachment) ||
      !(await ownerAttachment.attached(container.id, HERDR_SOCKET))
    )
      await guard.fail("exact owner-visible native attachment unavailable");
  };
  const server = async (input) => {
    onServerFailure = input.onExit;
    if (
      input.cwd !== hostCwd ||
      input.inheritEnvironment !== false ||
      !isDeepStrictEqual(
        input.configArgs,
        config.flatMap((value) => ["-c", value]),
      )
    )
      throw Error("Unisolated server launch refused");
    await checkOwner();
    try {
      await buildNativeProxy({
        output: join(slot, "proxy.mjs"),
        allocationId: key,
        cwd: containerCwd,
        profile,
        model,
        effort,
        upstream,
        socketPath: proxyPath,
      });
      await container.exec(
        clean({ ...environment, HERDR_PANE_ID: boundPane }, [
          CODEX,
          ...input.configArgs,
          "app-server",
          "--listen",
          `unix://${upstream}`,
        ]),
        { detached: true, cwd: containerCwd },
      );
      await container.exec(
        clean(environment, [
          NODE,
          "-e",
          'const fs=require("node:fs");const p=process.argv[1];const until=Date.now()+10000;const check=()=>{try{if(fs.lstatSync(p).isSocket())return;}catch{}if(Date.now()>until)process.exit(1);setTimeout(check,20)};check();',
          upstream,
        ]),
      );
      const proxyChild = await container.pipe(clean(environment, [NODE, `/eval/control/${key}/proxy.mjs`]));
      proxyController = new NativeProxyController({
        child: proxyChild,
        allocationId: key,
        socketPath: proxyPath,
        failed: async (error) => {
          monitorFailure = error;
          rootReadyReject(error);
          abort.abort();
          try {
            await container.stop("native protocol boundary lost");
          } finally {
            onServerFailure?.(null);
          }
        },
        handle: async (frame) => {
          if (frame.direction === "client") {
            const original = structuredClone(frame.message);
            if (original.method === "thread/start") {
              if (
                !isDeepStrictEqual(original.params?.config?.mcp_servers, {}) ||
                original.params.config.approval_policy !== "never"
              )
                throw Error("Native proxy configuration changed");
              delete original.params.config.mcp_servers;
              delete original.params.config.approval_policy;
            }
            const expected = hostProtocol.prepare(original);
            if (expected.kind !== frame.kind || !isDeepStrictEqual(expected.message, frame.message))
              throw Error("Native proxy request changed");
            await checkOwner();
            if (!source) throw Error("Native account monitor unavailable");
            if (frame.kind === "turn") {
              if (
                frame.message.method === "turn/steer" &&
                (!activeTurn || frame.message.params.expectedTurnId !== activeTurn)
              )
                throw Error("Native steer selected another turn");
              await activePolicy.beforeTurn({ threadId: frame.message.params.threadId });
            } else {
              if (frame.kind === "interrupt" && (!activeTurn || frame.message.params.turnId !== activeTurn))
                throw Error("Native interrupt selected another turn");
              if (
                ["read", "interrupt"].includes(frame.kind) &&
                frame.message.params?.threadId &&
                frame.message.params.threadId !== pendingRoot
              )
                throw Error("Native request selected another root");
              if (frame.kind === "start") {
                await configuration();
                guard.observe(await source.snapshot(now));
              }
              await guard.admit();
            }
            if (frame.message.id !== undefined) pendingRequests.set(frame.message.id, frame.message.method);
          } else if (frame.direction === "server") {
            const message = frame.message;
            if (message.id !== undefined) {
              const method = pendingRequests.get(message.id);
              pendingRequests.delete(message.id);
              if (!method || message.error) throw Error("Native server request failed or lost correlation");
              if (method === "thread/start") {
                const result = message.result;
                if (
                  pendingRoot ||
                  typeof result?.thread?.id !== "string" ||
                  result.thread.cwd !== containerCwd ||
                  result.cwd !== containerCwd ||
                  result.model !== model ||
                  result.reasoningEffort !== effort ||
                  result.modelProvider !== "openai" ||
                  result.approvalPolicy !== "never" ||
                  result.approvalsReviewer !== "user" ||
                  !isDeepStrictEqual(result.activePermissionProfile, { id: "lead_eval" }) ||
                  !isDeepStrictEqual(result.runtimeWorkspaceRoots, [containerCwd])
                )
                  throw Error("Native effective permission/root response mismatch");
                pendingRoot = result.thread.id;
                rootReadyResolve(pendingRoot);
              }
            } else if (message.method)
              await activePolicy.audit({ method: message.method, params: message.params ?? {} }, true);
            else throw Error("Malformed native upstream event");
          } else throw Error("Unknown native proxy direction");
        },
      });
      await proxyController.ready;
      return {
        endpoint,
        failure: () => monitorFailure,
        output: () => "Exact owned native container",
        async connect() {
          await checkOwner();
          const relay = await container.pipe(
            clean(environment, [CODEX, "app-server", "proxy", "--sock", `/eval/control/${key}/rpc.sock`]),
          );
          const stream = Duplex.from({ writable: relay.stdin, readable: relay.stdout });
          const lost = (error) => {
            stream.destroy(error);
            proxyController.close(error ?? Error("Native audit relay exited"));
          };
          relay.once("error", lost);
          relay.once("exit", () => lost(Error("Native audit relay exited")));
          const socket = await openCodexSocket("ws://localhost/", stream);
          if (!socket) relay.kill();
          else
            socket.once("close", () => {
              relay.kill();
              lost(Error("Native audit socket closed"));
            });
          return socket;
        },
        async close() {
          abort.abort();
          await container.stop("native seat closed");
          if (monitor) await monitor;
        },
      };
    } catch (error) {
      abort.abort();
      try {
        await container.stop("native server startup failed");
      } catch (stopError) {
        throw new AggregateError([error, stopError], "Native startup containment failed");
      }
      throw error;
    }
  };
  const herdr = (args, signal, timeoutMs) => {
    signal?.throwIfAborted();
    return container.exec(clean(environment, ["herdr", ...args]), { timeoutMs, signal });
  };
  const baseRunner = createHerdrWatchRunner(() => !container.stopped, herdr);
  const runner = {
    ...baseRunner,
    async createTab(input) {
      if (input.cwd !== hostCwd || input.fleet !== undefined) throw Error("Unallocated Herdr workspace");
      return baseRunner.createTab({ ...input, cwd: containerCwd, env: environment });
    },
  };
  const policy = (launch, view) => {
    if (boundPane !== undefined) throw Error("Allocated native seat cannot be launched twice");
    boundPane = view.paneId;
    writeNativeWrapper(join(slot, "bin", "codex"), environment, config, endpoint, {
      paneId: boundPane,
      model,
      effort,
    });
    activePolicy = {
      launch: {
        environment: { ...environment, HERDR_PANE_ID: view.paneId },
        socketRoot: `/eval/control/${key}`,
        config,
      },
      async connected(read) {
        trustedRead = read;
        await configuration();
        source = new CodexAccountSource((method, params) => read.request(method, params), {
          accountId,
          email,
        });
        guard.observe(await source.snapshot(now));
        await guard.admit();
        monitor = guard
          .monitor(
            [
              {
                snapshot: async (clock) => {
                  await checkOwner();
                  if (rootSession) {
                    const inventory = await source.inventory();
                    if (
                      inventory.threads.length !== 1 ||
                      inventory.threads[0].id !== rootSession ||
                      inventory.threads[0].cwd !== containerCwd
                    )
                      throw Error("Native inventory coverage changed");
                    ledger.inventory(inventory, now());
                  }
                  return source.snapshot(clock);
                },
              },
            ],
            abort.signal,
            5000,
          )
          .catch(async (error) => {
            monitorFailure = error;
            try {
              await container.stop(`trusted monitor failed: ${error.message}`);
            } finally {
              onServerFailure?.(null);
            }
          });
        // A failed stop is consumed here and retained, never an unhandled/log-only rejection.
        monitor = monitor.catch((error) => {
          monitorFailure = error;
        });
      },
      async bound({ threadId }) {
        if (rootSession === threadId) return;
        if (!pendingRoot) {
          let timer;
          try {
            await Promise.race([
              rootReady,
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(Error("Native root proof expired")), 2000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        if (rootSession || pendingRoot !== threadId)
          throw Error("Native root already bound or lacks trusted proxy proof");
        const before = await baseRunner.get(view.paneId);
        if (before.paneId !== view.paneId || before.agent !== "codex")
          throw Error("Allocated native pane unavailable");
        const processProof = await nativeTuiBinding({
          container,
          paneId: view.paneId,
          endpoint,
          cwd: containerCwd,
          codexHome: environment.CODEX_HOME,
          codexSha256: nativeRuntimeEvidence(container.capability).binaries[CODEX],
        });
        if (!processProof) throw Error("Exact native TUI process/socket proof unavailable");
        await herdr([
          "pane",
          "report-agent",
          view.paneId,
          "--source",
          "herdr:codex",
          "--agent",
          "codex",
          "--state",
          "idle",
          "--agent-session-id",
          threadId,
        ]);
        const pane = await baseRunner.get(view.paneId);
        if (pane.paneId !== view.paneId || pane.agent !== "codex" || pane.session?.value !== threadId)
          throw Error("Herdr pane/native thread proof unavailable");
        rootSession = threadId;
        ledger.record("native-process", { threadId, processProof });
        ledger.authorizeRoot({ sessionId: threadId, accountId, cwd: containerCwd, paneId: view.paneId });
        const inventory = await source.inventory();
        if (
          inventory.threads.length !== 1 ||
          inventory.threads[0].id !== rootSession ||
          inventory.threads[0].cwd !== containerCwd
        )
          throw Error("Native initial inventory mismatch");
        ledger.inventory(inventory, now());
      },
      async beforeTurn({ threadId }) {
        if (monitorFailure) throw monitorFailure;
        await configuration();
        await checkOwner();
        if (!rootSession) await activePolicy.bound({ threadId });
        if (threadId !== rootSession) throw Error("Native root changed");
        const inventory = await source.inventory();
        if (
          inventory.threads.length !== 1 ||
          inventory.threads[0].id !== rootSession ||
          inventory.threads[0].cwd !== containerCwd
        )
          throw Error("Unadmitted native descendant/session/workspace");
        ledger.inventory(inventory, now());
        guard.observe(await source.snapshot(now));
        await guard.admit();
      },
      async audit(event, fromProxy = false) {
        if (event.method === "turn/started") {
          if (!rootSession || event.params.threadId !== rootSession)
            throw Error("Native turn before exact root binding");
          await guard.admit();
        }
        if (fromProxy && event.method === "turn/started") activeTurn = event.params.turn?.id;
        if (fromProxy && event.method === "turn/completed" && event.params.turn?.id === activeTurn)
          activeTurn = undefined;
        if (event.method === "connection/closed") throw Error("Native audit connection lost");
        const id = event.params.threadId ?? event.params.thread?.id;
        if (rootSession && id && id !== rootSession) throw Error("Unadmitted native descendant");
        if (event.method === "thread/tokenUsage/updated") {
          if (!rootSession) throw Error("Native usage before exact root binding");
          // The independent trusted audit connection is the sole cumulative usage
          // writer; duplicate notifications from the TUI proxy may arrive out of order.
          if (fromProxy) return;
          ledger.usage(accountId, event);
          if (!ledger.result().complete) throw Error("Native usage coverage lost");
        }
      },
      async failed(error) {
        abort.abort();
        await container.stop(`native policy: ${String(error)}`);
      },
    };
    return activePolicy;
  };
  const adapter = createCodexSeatAdapter({
    server,
    nativePolicy: policy,
    herdr,
    trackerOverrides: async () => [],
  });
  return {
    ledger,
    environment,
    endpoint,
    config,
    captainOptions: {
      nativeHerdrRunner: runner,
      seatAdapters: [adapter],
      nativeLaunchPolicy: {
        async admit({ seat, phase, account, resumed }) {
          if (
            resumed ||
            seat.resume !== undefined ||
            seat.fleet !== undefined ||
            seat.harness !== "codex" ||
            seat.workingDirectory !== hostCwd ||
            seat.account !== accountLabel ||
            seat.chrome ||
            seat.skills !== "plain" ||
            seat.model !== model ||
            seat.effort !== effort
          )
            throw Error("Only the allocated fresh local native Codex seat is supported");
          if (phase === "launch" && (account?.home !== accountHome || account?.label !== accountLabel))
            throw Error("Selected account does not match allocation");
          await checkOwner();
          await validateNativeLaunchState({ root: container.root, hostCwd, accountHome });
        },
      },
    },
    /** Explicit startup step, never run by factory construction. */
    async startHerdr() {
      await container.exec(
        clean(
          {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            HOME: "/eval/control/home",
            HERDR_SOCKET_PATH: HERDR_SOCKET,
          },
          ["herdr", "server"],
        ),
        { detached: true },
      );
    },
  };
}

/** Multiple independent indexes/native account homes, one exact Herdr pane namespace. */
export function createNativeFleet({ container, allocations, ownerAttachment, now }) {
  if (!allocations.length) throw Error("No preallocated native hires");
  const paths = new Set(),
    indexes = new Set(),
    labels = new Set();
  for (const allocation of allocations) {
    const path = realpathSync(allocation.hostCwd);
    const git = join(path, ".git");
    if (!lstatSync(git).isDirectory() || lstatSync(git).isSymbolicLink())
      throw Error("Each native hire requires an independent repository/index directory");
    const index = join(realpathSync(git), "index");
    if (paths.has(path) || indexes.has(index) || labels.has(allocation.accountLabel))
      throw Error("Duplicate native worktree/index/account-home allocation");
    paths.add(path);
    indexes.add(index);
    labels.add(allocation.accountLabel);
  }
  const slots = allocations.map((allocation) => ({
    allocation,
    runtime: createNativeRuntime({ container, allocation, ownerAttachment, now }),
  }));
  const selected = (cwd) => {
    const slot = slots.find((slot) => slot.allocation.hostCwd === cwd);
    if (!slot) throw Error("No exact controller-preallocated hire");
    return slot.runtime;
  };
  const runner = {
    ...slots[0].runtime.captainOptions.nativeHerdrRunner,
    createTab: (input) => selected(input.cwd).captainOptions.nativeHerdrRunner.createTab(input),
  };
  const adapter = {
    harness: "codex",
    start: (launch, view, signal) =>
      selected(launch.cwd).captainOptions.seatAdapters[0].start(launch, view, signal),
    async attach(ref) {
      for (const slot of slots) {
        const control = await slot.runtime.captainOptions.seatAdapters[0].attach(ref);
        if (control) return control;
      }
    },
  };
  return {
    slots,
    startHerdr: () => slots[0].runtime.startHerdr(),
    captainOptions: {
      nativeHerdrRunner: runner,
      seatAdapters: [adapter],
      nativeLaunchPolicy: {
        admit: async (input) =>
          selected(input.seat.workingDirectory).captainOptions.nativeLaunchPolicy.admit(input),
      },
    },
  };
}
