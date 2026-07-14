import { Terminal } from "@xterm/headless";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TerminalManager, type TerminalTransport } from "../src/terminals.ts";
import { ShellWorkerAdapter } from "../src/shell-worker.ts";
import type { WorkerRunContext } from "@clankie/worker-sdk";

function scriptedTransport() {
  let data: ((chunk: Buffer) => void) | undefined;
  let exit: ((code: number | null) => void) | undefined;
  const writes: Buffer[] = [];
  const resizes: Array<[number, number]> = [];
  return {
    writes,
    resizes,
    emit: (chunk: Buffer | string) => data?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    finish: (code = 0) => exit?.(code),
    write: (bytes: Uint8Array) => writes.push(Buffer.from(bytes)),
    resize: (cols: number, rows: number) => resizes.push([cols, rows]),
    kill: () => exit?.(null),
    onData: (listener: (chunk: Buffer) => void) => {
      data = listener;
    },
    onExit: (listener: (code: number | null) => void) => {
      exit = listener;
    },
  } satisfies TerminalTransport & {
    writes: Buffer[];
    resizes: Array<[number, number]>;
    emit(chunk: Buffer | string): void;
    finish(code?: number): void;
  };
}

async function collect(stream: AsyncIterable<any>, stop?: (frame: any) => boolean) {
  const frames: any[] = [];
  for await (const frame of stream) {
    frames.push(frame);
    if (stop?.(frame)) break;
  }
  return frames;
}
const bytes = (frame: any) =>
  frame.type === "snapshot" || frame.type === "output" ? Buffer.from(frame.data, "base64") : Buffer.alloc(0);

describe("production terminal lifecycle", () => {
  it("runs a command in a real PTY with isatty, geometry, input, resize and ordered exit", async () => {
    const manager = new TerminalManager();
    const script =
      "process.stdin.setRawMode(true); process.stdout.write(JSON.stringify({tty:process.stdout.isTTY,cols:process.stdout.columns,rows:process.stdout.rows})+'\\n'); process.stdin.once('data',d=>{process.stdout.write('IN:'+d.toString('hex')+'\\n');process.exit(0)})";
    const session = manager.spawnTerminal({
      workerRunId: "run-pty",
      title: "pty",
      command: process.execPath,
      args: ["-e", script],
      columns: 91,
      rows: 27,
      env: { PATH: process.env.PATH },
    });
    const lease = await manager.acquireControl(session.id, "human");
    await manager.resize(session.id, lease.id, 100, 31);
    await manager.sendInput(session.id, lease.id, Buffer.from([0, 0xff, 0x41]));
    const frames = await collect(manager.observe(session.id));
    const raw = Buffer.concat(frames.filter((f) => f.type === "output").map(bytes));
    expect(raw.toString()).toContain('"tty":true');
    expect(raw.toString()).toContain('"cols":100');
    expect(raw.toString()).toContain("IN:00ff41");
    expect(frames.at(-1)?.type).toBe("closed");
    await expect(manager.sendInput(session.id, lease.id, Buffer.from("x"))).rejects.toThrow(
      /closed|valid control lease/,
    );
  });

  it("preserves arbitrary PTY bytes without a UTF-8 string round trip", async () => {
    const manager = new TerminalManager();
    const transport = scriptedTransport();
    const session = manager.spawnTerminal({
      workerRunId: "run-bytes",
      title: "bytes",
      command: "unused",
      transport,
    });
    const arbitrary = Buffer.from([0, 0xff, 0xfe, 0x1b, 0x5b, 0x41]);
    transport.emit(arbitrary);
    transport.finish();
    const frames = await collect(manager.observe(session.id));
    expect(Buffer.concat(frames.filter((f) => f.type === "output").map(bytes))).toEqual(arbitrary);
  });

  it("publishes snapshots only at UTF-8 and escape-parser quiescent boundaries", async () => {
    const manager = new TerminalManager({ maxBufferedFrames: 1 });
    const transport = scriptedTransport();
    const session = manager.spawnTerminal({
      workerRunId: "run-split",
      title: "split",
      command: "unused",
      transport,
    });
    transport.emit(Buffer.from([0xe2, 0x82]));
    transport.emit(Buffer.from([0xac, 0x1b, 0x5b]));
    await manager.whenIdle(session.id);
    const partial = await collect(manager.observe(session.id), (f) => f.type === "snapshot");
    expect(partial[0].sequence).toBe(0);
    transport.emit("31mOK\u001b[0m");
    transport.finish();
    await manager.whenIdle(session.id);
    const restored = await collect(manager.observe(session.id, 0));
    const snapshot = restored.find((f) => f.type === "snapshot");
    expect(snapshot.sequence).toBeGreaterThan(0);
  });

  it("restores alternate-buffer visible state from headless VT serialization", async () => {
    const manager = new TerminalManager({ maxBufferedFrames: 1 });
    const transport = scriptedTransport();
    const session = manager.spawnTerminal({
      workerRunId: "run-tui",
      title: "tui",
      command: "unused",
      transport,
      columns: 40,
      rows: 8,
    });
    transport.emit("\u001b[?1049h\u001b[2J\u001b[31mRED\u001b[4;9H界\u001b[0m");
    transport.emit("tail");
    transport.finish();
    await manager.whenIdle(session.id);
    const frames = await collect(manager.observe(session.id, 0));
    const snapshot = frames.find((f) => f.type === "snapshot");
    const recreated = new Terminal({ cols: snapshot.columns, rows: snapshot.rows, allowProposedApi: true });
    await new Promise<void>((resolve) => recreated.write(bytes(snapshot), resolve));
    expect(recreated.buffer.active.getLine(0)?.translateToString(true)).toContain("RED");
    expect(recreated.buffer.active.getLine(3)?.translateToString(true)).toContain("界tail");
  });

  it("bounds replay and resyncs a slow observer without stalling producer", async () => {
    const manager = new TerminalManager({ maxBufferedFrames: 4, maxObserverQueueFrames: 2 });
    const transport = scriptedTransport();
    const session = manager.spawnTerminal({
      workerRunId: "run-burst",
      title: "burst",
      command: "unused",
      transport,
    });
    const stream = manager.observe(session.id)[Symbol.asyncIterator]();
    await stream.next();
    for (let i = 0; i < 1000; i++) transport.emit(`line-${i}\n`);
    transport.finish();
    await manager.whenIdle(session.id);
    const frames: any[] = [];
    for (;;) {
      const item = await stream.next();
      if (item.done) break;
      frames.push(item.value);
    }
    expect(frames.some((f) => f.type === "snapshot")).toBe(true);
    expect(frames.length).toBeLessThan(10);
  });

  it("uses one renewable idempotent lease and emits one human-control handoff", async () => {
    const changes = vi.fn();
    const manager = new TerminalManager({ onHumanControlChanged: changes });
    const transport = scriptedTransport();
    const session = manager.spawnTerminal({
      workerRunId: "run-lease",
      title: "lease",
      command: "unused",
      transport,
    });
    const first = await manager.acquireControl(session.id, "same");
    const again = await manager.acquireControl(session.id, "same");
    expect(again.id).toBe(first.id);
    expect(manager.renewControl(session.id, first.id).id).toBe(first.id);
    await expect(manager.acquireControl(session.id, "other")).rejects.toThrow(/controlled/);
    await manager.releaseControl(session.id, first.id);
    expect(changes.mock.calls).toEqual([
      ["run-lease", true],
      ["run-lease", false],
    ]);
  });

  it("binds native session correlation only to the matching live attempt", () => {
    const manager = new TerminalManager();
    const a = manager.spawnTerminal({
      workerRunId: "run",
      title: "a",
      command: "unused",
      transport: scriptedTransport(),
      context: { missionId: "m", taskId: "t", attempt: 2, provider: "shell" },
    });
    manager.bindNativeSession("run", 1, "wrong");
    expect(manager.context(a.id).nativeSessionId).toBeUndefined();
    manager.bindNativeSession("run", 2, "native-1");
    expect(manager.context(a.id)).toMatchObject({
      missionId: "m",
      taskId: "t",
      workerRunId: "run",
      attempt: 2,
      nativeSessionId: "native-1",
    });
  });

  it("closes orphaned records on restart and excludes closed sessions from discovery", async () => {
    const manager = new TerminalManager();
    manager.spawnTerminal({
      id: "orphan",
      workerRunId: "run",
      title: "orphan",
      command: "unused",
      transport: scriptedTransport(),
    });
    expect(manager.closeOrphanedRecords()).toEqual(["orphan"]);
    await Promise.resolve();
    expect(await manager.listSessions()).toEqual([]);
  });

  it("registers the production ShellWorkerAdapter attempt in the injected manager and removes it on exit", async () => {
    const manager = new TerminalManager();
    const adapter = new ShellWorkerAdapter({
      id: "generic-shell",
      terminalManager: manager,
      commandForTask: () => ({
        command: process.execPath,
        args: ["-e", "if(!process.stdout.isTTY)process.exit(9)"],
      }),
    });
    const context = {
      missionId: "mission",
      workerRunId: "worker",
      attempt: 3,
      workspacePath: process.cwd(),
      profileHash: "profile",
      task: {
        id: "task",
        title: "shell",
        objective: "run",
        kind: "implementation",
        risk: "low",
        writeScope: [],
        successCriteria: [],
      },
      signal: new AbortController().signal,
      emit: () => undefined,
    } as unknown as WorkerRunContext;
    const result = await adapter.run(context);
    expect(result).toMatchObject({ status: "succeeded", outputs: { terminalId: expect.any(String) } });
    expect(await manager.listSessions()).toEqual([]);
    expect(manager.context(String(result.outputs.terminalId))).toMatchObject({
      missionId: "mission",
      taskId: "task",
      workerRunId: "worker",
      attempt: 3,
      provider: "generic-shell",
    });
  });

  it("escalates a timed-out TERM-trapping shell worker to SIGKILL within the grace period", async () => {
    const manager = new TerminalManager();
    const cancel = vi.spyOn(manager, "cancel");
    const kill = vi.spyOn(manager, "kill");
    const timeoutMs = 500;
    const terminationGraceMs = 100;
    const adapter = new ShellWorkerAdapter({
      id: "term-trapping-shell",
      terminalManager: manager,
      timeoutMs,
      terminationGraceMs,
      commandForTask: () => ({
        command: "/bin/sh",
        args: ["-c", "trap '' TERM; printf 'ready\\n'; while :; do sleep 1; done"],
      }),
    });
    const context = {
      missionId: "mission",
      workerRunId: "term-trap",
      attempt: 1,
      workspacePath: process.cwd(),
      profileHash: "profile",
      task: {
        id: "task",
        title: "trap TERM",
        objective: "prove timeout escalation",
        kind: "debugging",
        risk: "low",
        writeScope: [],
        successCriteria: [],
      },
      signal: new AbortController().signal,
      emit: () => undefined,
    } as unknown as WorkerRunContext;

    const startedAt = Date.now();
    const run = adapter.run(context);
    const outcome = await Promise.race([
      run.then((result) => ({ state: "settled" as const, result })),
      new Promise<{ state: "hung" }>((resolve) =>
        setTimeout(() => resolve({ state: "hung" }), timeoutMs + terminationGraceMs + 1_000),
      ),
    ]);
    if (outcome.state === "hung") {
      for (const session of await manager.listSessions()) manager.kill(session.id);
      await run;
    }

    expect(outcome.state).toBe("settled");
    if (outcome.state !== "settled") return;
    expect(outcome.result.status).toBe("failed");
    expect(Date.now() - startedAt).toBeLessThan(timeoutMs + terminationGraceMs + 1_000);
    expect(cancel).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledOnce();
    expect(await manager.listSessions()).toEqual([]);
  });

  it("escalates a timed-out TERM-trapping shell worker process group", async () => {
    const root = await mkdtemp(join(process.cwd(), ".clankie-shell-worker-tree-"));
    const grandchildPidPath = join(root, "grandchild.pid");
    let grandchildPid: number | undefined;
    try {
      const manager = new TerminalManager();
      const timeoutMs = 500;
      const terminationGraceMs = 100;
      const adapter = new ShellWorkerAdapter({
        id: "term-trapping-shell-tree",
        terminalManager: manager,
        timeoutMs,
        terminationGraceMs,
        commandForTask: () => ({
          command: "/bin/sh",
          args: [
            "-c",
            `trap '' TERM HUP; /bin/sh -c 'trap "" TERM HUP; while :; do sleep 1; done' & echo $! > ${JSON.stringify(grandchildPidPath)}; while :; do sleep 1; done`,
          ],
        }),
      });
      const context = {
        missionId: "mission",
        workerRunId: "term-trap-tree",
        attempt: 1,
        workspacePath: process.cwd(),
        profileHash: "profile",
        task: {
          id: "task",
          title: "trap TERM in process tree",
          objective: "prove timeout escalation owns the process tree",
          kind: "debugging",
          risk: "low",
          writeScope: [],
          successCriteria: [],
        },
        signal: new AbortController().signal,
        emit: () => undefined,
      } as unknown as WorkerRunContext;

      const result = await adapter.run(context);
      grandchildPid = Number(await readFile(grandchildPidPath, "utf8"));

      expect(result.status).toBe("failed");
      await expect(waitForProcessExit(grandchildPid, terminationGraceMs + 1_000)).resolves.toBe(true);
      expect(await manager.listSessions()).toEqual([]);
    } finally {
      if (grandchildPid !== undefined && processIsAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets a cooperative timed-out shell worker process group exit during the grace period", async () => {
    const manager = new TerminalManager();
    const cancel = vi.spyOn(manager, "cancel");
    const kill = vi.spyOn(manager, "kill");
    const adapter = new ShellWorkerAdapter({
      id: "cooperative-shell-tree",
      terminalManager: manager,
      timeoutMs: 500,
      terminationGraceMs: 500,
      commandForTask: () => ({
        command: "/bin/sh",
        args: ["-c", `trap 'exit 0' TERM; /bin/sh -c 'trap "exit 0" TERM; while :; do sleep 1; done' & wait`],
      }),
    });
    const context = {
      missionId: "mission",
      workerRunId: "cooperative-tree",
      attempt: 1,
      workspacePath: process.cwd(),
      profileHash: "profile",
      task: {
        id: "task",
        title: "cooperative process tree",
        objective: "exit during the timeout grace period",
        kind: "debugging",
        risk: "low",
        writeScope: [],
        successCriteria: [],
      },
      signal: new AbortController().signal,
      emit: () => undefined,
    } as unknown as WorkerRunContext;

    const result = await adapter.run(context);

    expect(result.status).toBe("failed");
    expect(cancel).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
    expect(await manager.listSessions()).toEqual([]);
  });
});

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !processIsAlive(pid);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
