// A Codex hire in the Herdr desktop app's terminals (ADR 0341), from the terminal's launch to
// its worker's tools. Real processes, real launch handoff and seat records on disk, the real
// Codex adapter, desktop runner, private-server registry and project proof; the core's socket
// (which needs the desktop app) and the Codex app-server stand in at their seams. The Mac's
// Herdr TUI server need not run at all: nothing here reaches a Herdr CLI.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
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
import { LocalCodexSeats } from "../src/local-codex-seats.ts";
import { fleetProcessHelper } from "../src/local-fleet-process.ts";
import { localProjectProof } from "../src/local-fleet-proof.ts";
import { closeNativeProcessObservers } from "../src/native-process-transport.ts";

const checkout = fileURLToPath(new URL("../../../", import.meta.url));
const codex = fileURLToPath(new URL("./fixtures/desktop-codex/codex.mjs", import.meta.url));
const helper = fleetProcessHelper(checkout);
// The view's own proof reads the real process's identity, as on the owner's Mac.
const processIt = it.skipIf(!["darwin", "linux"].includes(process.platform) || !existsSync(helper));

const children: ChildProcess[] = [];
const roots: string[] = [];
afterEach(async () => {
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
    let viewArgs: readonly string[] | undefined;
    const boundAs: HerdrCoreTerminal[] = [];
    const adapter = createCodexSeatAdapter({
      desktop: desktopCodexViews(runner, 50),
      localProcess: (pid, pane) => registry.register(pid, pane),
      trackerOverrides: async () => [],
      herdr: async (args) => {
        throw new Error(`No Herdr CLI answers for a desktop-app terminal: herdr ${args.join(" ")}`);
      },
      start: async (options) => {
        options.onServerStarted?.(server.pid!);
        await options.startView(["--remote", "unix:///owned/codex.sock"]);
        return {
          threadId: thread,
          viewArgs: ["--remote", "unix:///owned/codex.sock"],
          send: async () => ({ turnId: "turn-1", state: "started" as const }),
          close: async () => {},
          interrupt: async () => true,
        };
      },
    });
    const view: SeatView = {
      paneId,
      name: "kh7",
      run: async () => {
        throw new Error("A desktop-app terminal takes no typed command");
      },
      start: async (harness, argv) => {
        viewArgs = argv;
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
    expect(started.outcome).toBe("started");
    expect(viewArgs).toEqual(["--remote", "unix:///owned/codex.sock"]);
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
