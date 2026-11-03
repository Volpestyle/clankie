// A Codex hire in the Herdr desktop app's terminals (ADR 0341), from the terminal's launch to
// its worker's tools. Real processes, real launch handoff and seat records on disk, the real
// Codex adapter, desktop runner, private-server registry and project proof; the core's socket
// (which needs the desktop app) and the Codex app-server stand in at their seams. The Mac's
// Herdr TUI server need not run at all: nothing here reaches a Herdr CLI.
import { readPersistedConversation } from "./support/persisted-conversation.ts";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { build } from "esbuild";
import { promisify } from "node:util";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, expect, it } from "vitest";
import type { SeatRef, SeatView } from "@clankie/agent-hosts";
import { createCodexSeatAdapter } from "../src/captain/codex-seat-adapter.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import type { HerdrCoreSeats, HerdrCoreTerminal } from "../src/captain/herdr-core-seats.ts";
import { SEAT_LABEL } from "../src/captain/herdr-core-seats.ts";
import {
  HERDR_CORE_FLEET,
  createHerdrCoreRunner,
  desktopCodexViews,
  herdrCoreCensusFleet,
  readDesktopSeat,
} from "../src/captain/herdr-core-runner.ts";
import { codex0160Protocol } from "./fixtures/codex-0160-protocol.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { routeHerdrFleets } from "../src/captain/herdr-fleet-runner.ts";
import { createFleetSeatControl } from "../src/captain/fleet-seat-control.ts";
import { desktopCodexAdmission } from "../src/desktop-codex-admission.ts";
import { LocalCodexSeats } from "../src/local-codex-seats.ts";
import { fleetProcessHelper } from "../src/local-fleet-process.ts";
import { localProjectProof } from "../src/local-fleet-proof.ts";
import { closeNativeProcessObservers } from "../src/native-process-transport.ts";

const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const codex = fileURLToPath(new URL("./fixtures/desktop-codex/codex.mjs", import.meta.url));
const helper = fleetProcessHelper(checkout);
// The view's own proof reads the real process's identity, as on the owner's Mac.
const processIt = it.skipIf(!["darwin", "linux"].includes(process.platform));
beforeAll(async () => {
  if (["darwin", "linux"].includes(process.platform))
    await promisify(execFile)(process.execPath, [join(checkout, "scripts/build-fleet-proof.mjs")]);
});

const children: ChildProcess[] = [];
const cleanups: (() => Promise<void>)[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const child of children.splice(0)) child.kill();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  await closeNativeProcessObservers();
});

/** The desktop app's core at its socket: terminals that really run their program. */
function core(): HerdrCoreSeats & { terminals: Map<string, HerdrCoreTerminal> } {
  const terminals = new Map<string, HerdrCoreTerminal>();
  let next = 1;
  return {
    terminals,
    available: async () => true,
    start: async (request) => {
      const address = `t${next++}`;
      const child = spawn(request.argv[0]!, request.argv.slice(1), {
        cwd: request.cwd,
        env: { ...process.env, ...request.env },
        stdio: "ignore",
      });
      children.push(child);
      terminals.set(address, {
        address,
        state: "live",
        pid: child.pid!,
        cwd: request.cwd,
        labels: { ...request.labels, [SEAT_LABEL]: request.seat },
      });
      child.once("exit", () => {
        const terminal = terminals.get(address);
        if (terminal) terminals.set(address, { ...terminal, state: "finished" });
      });
      return address;
    },
    get: async (address) => terminals.get(address),
    list: async () => [...terminals.values()],
    kill: async (address) => {
      const terminal = terminals.get(address);
      if (terminal?.pid) process.kill(terminal.pid);
    },
    read: async () => "",
    label: async (address, labels) => {
      const terminal = terminals.get(address)!;
      terminals.set(address, { ...terminal, labels: { ...terminal.labels, ...labels } });
    },
    keys: async () => {},
  };
}

processIt(
  "a Codex hire starts its view in a desktop-app terminal, reports its thread there, and its worker's tools are proven through Clankie's own server",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "desktop-codex-"));
    roots.push(root);
    const seats = core();
    const node = await realpath(process.execPath);
    const runner = createHerdrCoreRunner({
      seats,
      launchDirectory: join(root, "launches"),
      seatDirectory: join(root, "seats"),
      harnessCommand: async (harness) => (harness === "codex" ? [node, codex] : undefined),
    });
    const coreBinding = {
      runtime: "external" as const,
      session: HERDR_CORE_FLEET,
      socketPath: "/tmp/core.sock",
    };
    const herdrBinding = { runtime: "external" as const, session: "default", socketPath: "/tmp/herdr.sock" };
    const registry = new LocalCodexSeats(
      () => herdrBinding,
      async () => "server-start",
      { path: join(root, "local-codex-seats.json"), observeOccupant: async () => undefined },
      () => coreBinding,
    );

    // The hire's terminal waits at the launcher until its view's command arrives.
    const address = await runner.createTab({ cwd: root, harness: "codex", label: "clankie · Work" });
    const paneId = `${HERDR_CORE_FLEET}/${address}`;
    const thread = "019a3c5e-1d2a-7c8b-9e7f-6a5b4c3d2e1f";
    // Clankie's own app-server for this hire: a real process the worker bridge runs under.
    const server = spawn(node, [codex], { stdio: "ignore" });
    children.push(server);
    const native = await codex0160Protocol(root, { threadId: thread, socketPath: join(root, "rpc.sock") });
    cleanups.push(native.close);
    let viewArgs: readonly string[] | undefined;
    const boundAs: HerdrCoreTerminal[] = [];
    const adapter = createCodexSeatAdapter({
      desktop: desktopCodexViews(runner, 50),
      localProcess: (pid, pane) => registry.register(pid, pane),
      trackerOverrides: async () => [],
      herdr: async (args) => {
        throw new Error(`No Herdr CLI answers for a desktop-app terminal: herdr ${args.join(" ")}`);
      },
      server: async (input) => ({ ...(await native.launch(input)), pid: server.pid! }),
    });
    const view: SeatView = {
      paneId,
      name: "kh7",
      run: async () => {
        throw new Error("A desktop-app terminal takes no typed command");
      },
      start: async (harness, argv) => {
        viewArgs = argv;
        native.startView();
        await runner.startAgent({ name: "kh7", kind: harness, paneId: address, args: argv });
      },
      bound: async (ref: SeatRef) => {
        // What herdr-watch checks before the brief: the live terminal holds this exact thread.
        const agent = await runner.get(address);
        expect(agent).toMatchObject({
          agent: "codex",
          status: "idle",
          session: { source: "herdr:codex", kind: "id", value: ref.sessionId },
        });
        boundAs.push((await seats.get(address))!);
      },
    };

    const started = await adapter.start({ harness: "codex", cwd: root, brief: "" }, view);
    expect(started.outcome, JSON.stringify(started)).toBe("started");
    expect(viewArgs?.[viewArgs.indexOf("--cd") + 1]).toBe(root);
    expect(viewArgs).toContain(native.endpoint);
    expect(boundAs).toHaveLength(1);

    // The launcher exec'd the installed Codex in the terminal's own process, and Clankie
    // recorded that process with the thread his server reported, as a seat's proof trusts.
    const terminal = (await seats.get(address))!;
    expect(await readDesktopSeat(join(root, "seats"), address)).toEqual({
      pid: terminal.pid,
      agent: "codex",
      session: thread,
    });
    // The hire is a seat in the census, under its thread.
    const census = JSON.parse(
      await herdrCoreCensusFleet(runner, async () => true).run(["agent", "list"]),
    ) as { result: { agents: { pane_id: string; agent: string; agent_session: { value: string } }[] } };
    expect(census.result.agents).toEqual([
      expect.objectContaining({
        pane_id: address,
        agent: "codex",
        agent_session: expect.objectContaining({ value: thread }),
      }),
    ]);
    // A later report can't move the terminal to another thread.
    await expect(
      runner.reportAgent(address, {
        agent: "codex",
        state: "idle",
        session: "019a0000-0000-7000-8000-000000000000",
      }),
    ).rejects.toThrow(/another session/u);

    // The registration lives only in memory: the Herdr-pane recovery file never names a desktop terminal.
    const occupant = occupantIdForHerdrSession({ source: "herdr:codex", kind: "id", value: thread });
    expect(await registry.allows([server.pid!], paneId, coreBinding, occupant)).toBe(true);
    expect(await registry.allows([server.pid!], paneId, herdrBinding, occupant)).toBe(false);
    expect(
      existsSync(join(root, "local-codex-seats.json"))
        ? await readFile(join(root, "local-codex-seats.json"), "utf8")
        : "",
    ).not.toContain(HERDR_CORE_FLEET);

    // The worker bridge connects from under Clankie's server, not from under the view. Its
    // project proof proves the view by Clankie's record and the server by its registration.
    const bridge = 999_991;
    const socket = {
      remoteAddress: "127.0.0.1",
      localAddress: "127.0.0.1",
      remotePort: 51_000,
      localPort: 42_000,
      destroyed: false,
      readable: true,
      writable: true,
    } as Socket;
    const owner = {
      pid: bridge,
      uid: process.getuid?.() ?? 0,
      birth: ["1791190001", "000001"] as const,
      socket: "tcp",
    };
    const prove = (privateRegistry: LocalCodexSeats) =>
      localProjectProof({
        herdrBinary: "herdr",
        processHelper: helper,
        binding: async () => herdrBinding,
        coreBinding: async () => coreBinding,
        coreSeat: async (_binding, at) => (await readDesktopSeat(join(root, "seats"), at)) ?? null,
        launcher: async () => ({ executable: node, script: codex }),
        observeSocket: async () => ({
          schemaVersion: 1,
          owner,
          ancestors: [
            { pid: bridge, ppid: server.pid!, birth: owner.birth },
            { pid: server.pid!, ppid: 1, birth: ["1791190000", "000001"] },
          ],
        }),
        privateSeat: (chain, pane, binding) => privateRegistry.allows(chain, pane, binding),
        privateProjectSeat: (chain, pane, binding, proof) =>
          privateRegistry.allows(chain, pane, binding, proof.nativeOccupantId),
      });
    expect(await prove(registry)(socket, paneId)).toMatchObject({
      pane: paneId,
      nativeOccupantId: occupant,
      binding: { socketPath: coreBinding.socketPath, session: HERDR_CORE_FLEET },
      processes: [{ pid: terminal.pid }],
      privateSeat: true,
    });
    // Without Clankie's registration of that server, nothing under it is admitted.
    const empty = new LocalCodexSeats(
      () => herdrBinding,
      async () => "server-start",
      undefined,
      () => coreBinding,
    );
    expect(await prove(empty)(socket, paneId)).toBeUndefined();

    // Once the terminal ends, the seat hears it and lets the registration go.
    await runner.closePane(address);
    await expect
      .poll(() => registry.allows([server.pid!], paneId, coreBinding, occupant), { timeout: 5_000 })
      .toBe(false);
    expect(await readDesktopSeat(join(root, "seats"), address)).toBeUndefined();
  },
);

it("a Codex launch names no session on its command line, so only its server's report seats it", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-codex-args-"));
  roots.push(root);
  const seats = core();
  const runner = createHerdrCoreRunner({
    seats,
    launchDirectory: join(root, "launches"),
    seatDirectory: join(root, "seats"),
    harnessCommand: async () => ["/bin/sh", "-c", "sleep 30", "codex"],
  });
  const address = await runner.createTab({ cwd: root, harness: "codex", label: "clankie · Work" });
  // A `--resume` among Codex's own arguments is not a Claude session to label.
  await runner.startAgent({
    name: "kh8",
    kind: "codex",
    paneId: address,
    args: ["-c", "x=1", "--resume", "nope"],
  });
  expect((await runner.get(address)).session).toBeUndefined();
  expect(await readDesktopSeat(join(root, "seats"), address)).toBeUndefined();
  // A report for another harness than the one started there is refused.
  await expect(runner.reportAgent(address, { agent: "claude", session: "nope" })).rejects.toThrow(
    /not running/u,
  );
  const census = JSON.parse(await herdrCoreCensusFleet(runner, async () => true).run(["agent", "list"]));
  expect(census.result.agents).toEqual([]);
});

// Real surviving view process and dedicated Unix protocol server; reconstruct
// service controllers and desktop runner without touching the installed service.
processIt("delivers and reports once across a desktop Codex service restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-restart-"));
  roots.push(root);
  const seats = core();
  const runnerOptions = {
    seats,
    launchDirectory: join(root, "launches"),
    seatDirectory: join(root, "seats"),
    harnessCommand: async () => [await realpath(process.execPath), codex],
  };
  const runner = createHerdrCoreRunner(runnerOptions);
  const native = await codex0160Protocol(root, { socketPath: join(root, "rpc.sock") });
  cleanups.push(native.close);
  await chmod(join(root, "rpc.sock"), 0o600);
  const adapter = createCodexSeatAdapter({
    desktop: desktopCodexViews(runner),
    server: native.launch,
    trackerOverrides: async () => [],
  });
  const address = await runner.createTab({ cwd: root, harness: "codex", label: "restart proof" });
  const paneId = `${HERDR_CORE_FLEET}/${address}`;
  const started = await adapter.start(
    { harness: "codex", cwd: root, brief: "" },
    {
      paneId,
      name: "restart-proof",
      run: async () => {
        throw new Error("No terminal fallback");
      },
      start: async (kind, argv) => {
        native.startView();
        await runner.startAgent({ name: "restart-proof", kind, paneId: address, args: argv });
      },
    },
  );
  expect(started.outcome).toBe("started");
  const binding = {
    runtime: "external" as const,
    session: HERDR_CORE_FLEET,
    socketPath: join(root, "core.sock"),
  };
  // Production's kernel guard must reject this fixture's Node listener as a
  // Codex app-server. Only the explicit fixture seam below substitutes it.
  expect(await desktopCodexAdmission(runner, () => binding)([process.pid], paneId, binding)).toBe(false);
  const routed = (desktop: ReturnType<typeof createHerdrCoreRunner>) =>
    routeHerdrFleets(
      {
        get: async () => {
          throw new Error("No legacy pane");
        },
        resolveTerminal: async () => undefined,
        wait: async () => {
          throw new Error("No terminal fallback");
        },
      },
      new Map([[HERDR_CORE_FLEET, desktop]]),
    );
  const path = join(root, "watch.json");
  const before = new HerdrWatchStore(path, {
    runner: routed(runner),
    seatAdapters: [adapter],
  });
  cleanups.push(async () => {
    before.close();
    if (started.outcome === "started") await started.control.close();
  });
  expect(await before.deliverToSeat(paneId, "Before restart")).toMatchObject({ outcome: "delivered" });
  before.close();
  const coldRunner = routed(createHerdrCoreRunner(runnerOptions));
  const after = new HerdrWatchStore(path, {
    runner: coldRunner,
    seatAdapters: [],
    remoteSeatAdapters: () => [],
    remoteCodexQueue: async () => {
      throw new Error("Local desktop must never use SSH queue");
    },
  });
  cleanups.push(async () => after.close());
  expect(await after.deliverToSeat(paneId, "Steer after restart")).toMatchObject({
    outcome: "delivered",
    state: "steered",
  });
  expect(native.requests.filter(({ method }) => method === "turn/steer")).toHaveLength(1);
  native.finish("completed", "Finished after restart");
  const options = { stableReceiptKey: "post-restart-original", delivery: "queue" as const };
  expect(await after.deliverToSeat(paneId, "After restart", undefined, options)).toMatchObject({
    outcome: "delivered",
    state: "queued",
    messageId: expect.stringMatching(/^codex-input:/u),
  });
  expect(await after.deliverToSeat(paneId, "After restart", undefined, options)).toMatchObject({
    outcome: "delivered",
  });
  expect(native.requests.filter(({ method }) => method === "thread/queue/add")).toHaveLength(1);
  expect(
    (await coldRunner.transcript!((await coldRunner.resolveTerminal(paneId))!))?.entries.some(
      (entry) => entry.type === "message" && entry.text === "After restart",
    ),
  ).toBe(true);

  // Kill and replace an actual disposable service process as well: the view
  // PID and native server survive. Its durable receipt must survive too.
  await writeFile(join(root, "terminals.json"), JSON.stringify([...seats.terminals.values()]));
  await writeFile(
    join(root, "native-server.json"),
    JSON.stringify({
      pid: process.pid,
      endpoint: native.endpoint,
      paneId,
      threadId: (await runner.get(address)).session!.value,
    }),
  );
  const entry = join(root, "delivery-service.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/desktop-codex-delivery-service.ts", import.meta.url))],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    banner: {
      js: "import { createRequire as fixtureRequire } from 'node:module'; const require = fixtureRequire(import.meta.url);",
    },
  });
  const startService = async (initial = false) => {
    const child = spawn(process.execPath, [entry, root, helper, initial ? "initial" : "restarted"], {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        USERPROFILE: root,
        NODE_ENV: "test",
        VITEST: "true",
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    let stderr = "";
    child.stderr!.on("data", (bytes) => {
      stderr += String(bytes);
    });
    const ready = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error(stderr);
      }),
    ]);
    expect(ready[0]).toMatchObject({ ready: true, port: expect.any(Number) });
    return Object.assign(child, { port: (ready[0] as { port: number }).port, stderr: () => stderr });
  };
  const send = async (
    child: ChildProcess,
    text = "Across process restart",
    receipt = "process-restart-original",
  ) => {
    const result = once(child, "message");
    child.send({ seatId: paneId, text, receipt });
    return (await result)[0];
  };
  const report = async (
    service: { port: number; stderr: () => string },
    deliveryId: string,
    text: string,
  ) => {
    const response = await fetch(
      `http://127.0.0.1:${service.port}/v1/fleet/seats/${encodeURIComponent(paneId)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-clankie-pane": paneId },
        body: JSON.stringify({
          schemaVersion: 1,
          text,
          delivery: { id: deliveryId, binding: "a".repeat(64) },
        }),
      },
    );
    const result = { status: response.status, body: await response.json() };
    // An unavailable admission prints the service's own account of it (#564). An assertion diff
    // would not: toMatchObject leaves out keys the expectation does not name.
    if (response.status === 503)
      console.error(`report ${response.status}:\n${service.stderr().slice(-4000)}`);
    return result;
  };
  const firstService = await startService(true);
  expect(await report(firstService, randomUUID(), "Before restart report")).toMatchObject({
    status: 200,
    body: { deliveryStage: "stored" },
  });
  expect(await send(firstService)).toMatchObject({ result: { outcome: "delivered" } });
  const exited = once(firstService, "exit");
  firstService.kill("SIGKILL");
  await exited;
  const secondService = await startService();
  expect(await send(secondService)).toMatchObject({ result: { outcome: "delivered" } });
  expect(
    await send(secondService, "New message after process restart", "new-process-original"),
  ).toMatchObject({ result: { outcome: "delivered" } });
  expect(
    await send(secondService, "New message after process restart", "new-process-original"),
  ).toMatchObject({ result: { outcome: "delivered" } });
  const reportId = randomUUID();
  expect(await report(secondService, reportId, "After restart report")).toMatchObject({
    status: 200,
    body: { received: true, deliveryStage: "stored" },
  });
  expect(await report(secondService, reportId, "After restart report")).toMatchObject({
    status: 200,
    body: { deliveryStage: "stored" },
  });
  const meta = readPersistedConversation(join(root, "conversations/global-default/meta.json"));
  expect(
    Object.values(meta.inboundAcceptances).filter(
      (entry) => (entry as { text: string }).text === "After restart report",
    ),
  ).toHaveLength(1);
  native.loadedInventory({ data: [randomUUID()], nextCursor: null });
  expect((await report(secondService, randomUUID(), "Foreign session report")).status).toBe(403);
  native.loadedInventory(undefined);
  // The same socket/request owner cannot report through a replaced terminal PID.
  const originalTerminal = seats.terminals.get(address)!;
  await writeFile(
    join(root, "terminals.json"),
    JSON.stringify([{ ...originalTerminal, pid: secondService.pid }]),
  );
  expect((await report(secondService, randomUUID(), "Replacement report")).status).toBe(403);
  await writeFile(join(root, "terminals.json"), JSON.stringify([...seats.terminals.values()]));
  const seatRecord = join(root, "seats", `${address}.json`);
  await rename(seatRecord, `${seatRecord}.held`);
  expect((await report(secondService, randomUUID(), "Unhired terminal report")).status).toBe(403);
  await rename(`${seatRecord}.held`, seatRecord);
  // Refused attempts stored nothing; only the two admitted report IDs remain.
  expect(
    Object.keys(
      readPersistedConversation(join(root, "conversations/global-default/meta.json")).inboundAcceptances,
    ),
  ).toHaveLength(2);
  const processStopped = once(secondService, "exit");
  secondService.kill("SIGTERM");
  await processStopped;

  // Same native boundary, with an elapsed settlement clock. A rejected write is
  // uncertain until the exact transcript is read; never replay that original.
  let now = Date.now();
  const control = createFleetSeatControl(
    coldRunner,
    new Map(),
    undefined,
    undefined,
    undefined,
    join(root, "uncertain.json"),
    undefined,
    undefined,
    { now: () => now },
  );
  native.failNextQueue("absent");
  const absentOptions = { stableReceiptKey: "absent-original" };
  expect(await control.deliverToSeat(paneId, "Absent original", undefined, absentOptions)).toMatchObject({
    outcome: "unconfirmed",
  });
  expect(await control.deliverToSeat(paneId, "Later message")).toMatchObject({ outcome: "undelivered" });
  now += 5 * 60_000;
  expect(await control.deliverToSeat(paneId, "Later message")).toMatchObject({ outcome: "delivered" });
  await expect(control.deliverToSeat(paneId, "Absent original", undefined, absentOptions)).rejects.toThrow(
    "reconcile its original receipt",
  );
  native.failNextQueue("arrived");
  expect(await control.deliverToSeat(paneId, "Arrived without ack")).toMatchObject({
    outcome: "unconfirmed",
  });
  expect(await control.deliverToSeat(paneId, "Arrived without ack")).toMatchObject({
    outcome: "delivered",
    deliveryStage: "consumed",
  });
  const queuedText = native.requests
    .filter(({ method }) => method === "thread/queue/add")
    .map(({ params }) => (params.input as { text: string }[])[0]!.text);
  expect(queuedText).toEqual([
    "After restart",
    "Across process restart",
    "New message after process restart",
    "Absent original",
    "Later message",
    "Arrived without ack",
  ]);
  // A replaced terminal PID cannot supply the old hire's socket or transcript.
  const terminal = seats.terminals.get(address)!;
  seats.terminals.set(address, { ...terminal, pid: process.pid });
  expect(await control.deliverToSeat(paneId, "Must not reach a replacement")).toMatchObject({
    outcome: "undelivered",
  });
  expect(native.requests.filter(({ method }) => method === "thread/queue/add")).toHaveLength(6);
});
