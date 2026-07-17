import { createHash } from "node:crypto";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import type { ControlLease, TerminalFrame } from "@clankie/terminal-protocol";
import { describe, expect, it } from "vitest";
import { TerminalManager, type TerminalTransport } from "../src/terminals.ts";

function scriptedTransport() {
  let dataListener: ((chunk: Buffer) => void) | undefined;
  let exitListener: ((code: number | null) => void) | undefined;
  const writes: Buffer[] = [];
  return {
    writes,
    emit: (chunk: Buffer | string) => dataListener?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
    finish: (code = 0) => exitListener?.(code),
    write: (bytes: Uint8Array) => writes.push(Buffer.from(bytes)),
    resize: () => undefined,
    kill: () => exitListener?.(null),
    onData: (listener: (chunk: Buffer) => void) => {
      dataListener = listener;
    },
    onExit: (listener: (code: number | null) => void) => {
      exitListener = listener;
    },
  } satisfies TerminalTransport & {
    writes: Buffer[];
    emit(chunk: Buffer | string): void;
    finish(code?: number): void;
  };
}

function frameBytes(frame: TerminalFrame): Buffer {
  return frame.type === "snapshot" || frame.type === "output"
    ? Buffer.from(frame.data, "base64")
    : Buffer.alloc(0);
}

async function collect(
  stream: AsyncIterable<TerminalFrame>,
  stop?: (frame: TerminalFrame) => boolean,
): Promise<TerminalFrame[]> {
  const frames: TerminalFrame[] = [];
  for await (const frame of stream) {
    frames.push(frame);
    if (stop?.(frame)) break;
  }
  return frames;
}

async function writeTerminal(terminal: Terminal, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(bytes, resolve));
}

function terminalDigest(terminal: Terminal): string {
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  return createHash("sha256").update(serializer.serialize()).digest("hex");
}

async function reconstruct(frames: TerminalFrame[]): Promise<string> {
  const snapshot = frames.find(
    (frame): frame is Extract<TerminalFrame, { type: "snapshot" }> => frame.type === "snapshot",
  );
  expect(snapshot, "reconstruction requires a VT restore snapshot").toBeDefined();
  const terminal = new Terminal({
    cols: snapshot!.columns,
    rows: snapshot!.rows,
    allowProposedApi: true,
  });
  await writeTerminal(terminal, frameBytes(snapshot!));
  for (const frame of frames.slice(frames.indexOf(snapshot!) + 1)) {
    if (frame.type === "resized") terminal.resize(frame.columns, frame.rows);
    if (frame.type === "output") await writeTerminal(terminal, frameBytes(frame));
  }
  return terminalDigest(terminal);
}

function sequences(frames: TerminalFrame[]): number[] {
  return frames.map((frame) => frame.sequence);
}

type QueueInspectableManager = {
  terminals: Map<string, { observers: Set<{ queue: TerminalFrame[] }> }>;
};

function soleObserverQueueDepth(manager: TerminalManager, terminalId: string): number {
  const record = (manager as unknown as QueueInspectableManager).terminals.get(terminalId);
  expect(record, `terminal ${terminalId} must exist while its observer drains`).toBeDefined();
  expect(record!.observers.size, `terminal ${terminalId} must have exactly one observer`).toBe(1);
  return [...record!.observers][0]!.queue.length;
}

const line = (index: number) => `line-${String(index).padStart(6, "0")}\n`;

const parserBoundaryCases: Array<{ name: string; partial: Buffer; completion: Buffer }> = [
  { name: "ESC intermediate", partial: Buffer.from("\u001b("), completion: Buffer.from("B") },
  { name: "OSC BEL", partial: Buffer.from("\u001b]0;title"), completion: Buffer.from([0x07]) },
  { name: "OSC ESC backslash", partial: Buffer.from("\u001b]0;title"), completion: Buffer.from("\u001b\\") },
  { name: "OSC 8-bit ST", partial: Buffer.from("\u001b]0;title"), completion: Buffer.from([0x9c]) },
  { name: "DCS ESC backslash", partial: Buffer.from("\u001bP1;2|data"), completion: Buffer.from("\u001b\\") },
  { name: "DCS 8-bit ST", partial: Buffer.from("\u001bP1;2|data"), completion: Buffer.from([0x9c]) },
  { name: "CSI CAN", partial: Buffer.from("\u001b[31"), completion: Buffer.from([0x18]) },
  { name: "DCS SUB", partial: Buffer.from("\u001bPdata"), completion: Buffer.from([0x1a]) },
  { name: "UTF-8", partial: Buffer.from([0xe2, 0x82]), completion: Buffer.from([0xac]) },
];

describe("production terminal acceptance contract", () => {
  it("resumes a mid-stream reconnect at exactly last+1 without duplicate or missing output", async () => {
    const transport = scriptedTransport();
    const manager = new TerminalManager();
    const session = manager.spawnTerminal({
      workerRunId: "accept-reconnect",
      title: "reconnect",
      command: "unused",
      transport,
    });

    const iterator = manager.observe(session.id)[Symbol.asyncIterator]();
    const first: TerminalFrame[] = [(await iterator.next()).value!];
    for (let index = 0; index < 50; index += 1) transport.emit(line(index));
    await manager.whenIdle(session.id);
    while (first.at(-1)?.sequence !== 30) first.push((await iterator.next()).value!);
    await iterator.return?.();
    for (let index = 50; index < 80; index += 1) transport.emit(line(index));
    transport.finish();
    await manager.whenIdle(session.id);

    const resumed = await collect(manager.observe(session.id, 30));
    expect(sequences(resumed)).toEqual(resumed.map((_, offset) => 31 + offset));
    expect(resumed.at(-1)?.type).toBe("closed");
    expect(
      Buffer.concat([...first, ...resumed].filter((frame) => frame.type === "output").map(frameBytes)),
    ).toEqual(Buffer.from(Array.from({ length: 80 }, (_, index) => line(index)).join("")));
  });

  it("A1 replays every frame after an older quiescent snapshot across a partial CSI and UTF-8 boundary", async () => {
    const transport = scriptedTransport();
    const manager = new TerminalManager();
    const session = manager.spawnTerminal({
      workerRunId: "accept-a1",
      title: "a1",
      command: "unused",
      transport,
      columns: 40,
      rows: 8,
    });
    const uninterrupted = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });

    const first = Buffer.from("hello\r\n");
    const partial = Buffer.concat([Buffer.from("world"), Buffer.from([0xe2, 0x82, 0xac, 0x1b, 0x5b])]);
    const completion = Buffer.from("31mZ");
    transport.emit(first);
    await writeTerminal(uninterrupted, first);
    await manager.whenIdle(session.id);
    transport.emit(partial);
    await writeTerminal(uninterrupted, partial);
    await manager.whenIdle(session.id);

    const iterator = manager.observe(session.id)[Symbol.asyncIterator]();
    const initial = await iterator.next();
    expect(initial.value?.type).toBe("snapshot");
    expect(initial.value?.sequence).toBe(1);

    transport.emit(completion);
    transport.finish();
    await writeTerminal(uninterrupted, completion);
    await manager.whenIdle(session.id);
    const frames = [initial.value!];
    for (;;) {
      const item = await iterator.next();
      if (item.done) break;
      frames.push(item.value);
    }

    expect(sequences(frames)).toEqual([1, 2, 3, 4]);
    expect(await reconstruct(frames)).toBe(terminalDigest(uninterrupted));
  });

  it("A2 keeps snapshot bytes, sequence and geometry atomic and applies the resize tail", async () => {
    const transport = scriptedTransport();
    const manager = new TerminalManager();
    const session = manager.spawnTerminal({
      workerRunId: "accept-a2",
      title: "a2",
      command: "unused",
      transport,
      columns: 120,
      rows: 12,
    });
    const uninterrupted = new Terminal({ cols: 120, rows: 12, allowProposedApi: true });
    const content = Buffer.from("0123456789".repeat(9));
    transport.emit(content);
    await writeTerminal(uninterrupted, content);
    await manager.whenIdle(session.id);
    const lease = await manager.acquireControl(session.id, "geometry-controller");
    await manager.resize(session.id, lease.id, 40, 10);
    uninterrupted.resize(40, 10);

    const iterator = manager.observe(session.id)[Symbol.asyncIterator]();
    const initial = await iterator.next();
    expect(initial.value).toMatchObject({ type: "snapshot", sequence: 1, columns: 120, rows: 12 });
    transport.finish();
    await manager.whenIdle(session.id);
    const frames = [initial.value!];
    for (;;) {
      const item = await iterator.next();
      if (item.done) break;
      frames.push(item.value);
    }

    expect(frames[1]).toMatchObject({ type: "resized", sequence: 2, columns: 40, rows: 10 });
    expect(sequences(frames)).toEqual([1, 2, 3]);
    expect(await reconstruct(frames)).toBe(terminalDigest(uninterrupted));
  });

  it("late join beyond the replay buffer gets one VT restore snapshot plus a contiguous tail", async () => {
    const transport = scriptedTransport();
    const manager = new TerminalManager({ maxBufferedBytes: 256, maxBufferedFrames: 8 });
    const session = manager.spawnTerminal({
      workerRunId: "accept-late-join",
      title: "late join",
      command: "unused",
      transport,
      columns: 80,
      rows: 24,
    });
    const uninterrupted = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    for (let index = 0; index < 100; index += 1) {
      const chunk = Buffer.from(line(index));
      transport.emit(chunk);
      await writeTerminal(uninterrupted, chunk);
    }
    transport.finish();
    await manager.whenIdle(session.id);

    const frames = await collect(manager.observe(session.id, 1));
    expect(frames.filter((frame) => frame.type === "snapshot")).toHaveLength(1);
    expect(sequences(frames)).toEqual(frames.map((_, offset) => (frames[0]?.sequence ?? -1) + offset));
    expect(frames.at(-1)?.type).toBe("closed");
    expect(await reconstruct(frames)).toBe(terminalDigest(uninterrupted));
  });

  it("delivers high-throughput live output byte-exactly with contiguous sequences", async () => {
    const transport = scriptedTransport();
    const manager = new TerminalManager({ maxObserverQueueFrames: 4096, maxBufferedFrames: 4096 });
    const session = manager.spawnTerminal({
      workerRunId: "accept-throughput",
      title: "throughput",
      command: "unused",
      transport,
    });
    const iterator = manager.observe(session.id)[Symbol.asyncIterator]();
    const firstPull = iterator.next();
    const total = 2_000;
    for (let index = 0; index < total; index += 1) transport.emit(line(index));
    transport.finish();
    const frames = [(await firstPull).value!];
    await manager.whenIdle(session.id);
    for (;;) {
      const item = await iterator.next();
      if (item.done) break;
      frames.push(item.value);
    }

    expect(sequences(frames)).toEqual(frames.map((_, offset) => offset));
    expect(Buffer.concat(frames.filter((frame) => frame.type === "output").map(frameBytes))).toEqual(
      Buffer.from(Array.from({ length: total }, (_, index) => line(index)).join("")),
    );
    expect(frames.at(-1)?.type).toBe("closed");
  });

  it("allows lease-free observation but rejects missing, observe-only, stale and contended control", async () => {
    const transport = scriptedTransport();
    const observeLease: ControlLease = {
      id: "observe-only",
      terminalId: "accept-control",
      principalId: "watcher",
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      mode: "observe",
    };
    const leases = {
      acquire: () => observeLease,
      assert: () => observeLease,
      release: () => undefined,
      revoke: () => undefined,
      renew: () => observeLease,
      active: () => observeLease,
      expireStale: () => undefined,
    };
    const observeOnlyManager = new TerminalManager({ leases: leases as never });
    const observed = observeOnlyManager.spawnTerminal({
      id: "accept-control",
      workerRunId: "accept-control",
      title: "control",
      command: "unused",
      transport,
    });
    const first = await observeOnlyManager.observe(observed.id)[Symbol.asyncIterator]().next();
    expect(first.value?.type).toBe("snapshot");
    await expect(
      observeOnlyManager.sendInput(observed.id, observeLease.id, Buffer.from("x")),
    ).rejects.toThrow(/observe-only|control lease/);
    await expect(observeOnlyManager.resize(observed.id, observeLease.id, 90, 30)).rejects.toThrow(
      /observe-only|control lease/,
    );

    const manager = new TerminalManager();
    const controlled = manager.spawnTerminal({
      workerRunId: "accept-control-live",
      title: "control",
      command: "unused",
      transport: scriptedTransport(),
    });
    await expect(manager.sendInput(controlled.id, "missing", Buffer.from("x"))).rejects.toThrow(
      /valid control lease/,
    );
    const lease = await manager.acquireControl(controlled.id, "owner");
    await expect(manager.acquireControl(controlled.id, "contender")).rejects.toThrow(/controlled/);
    await manager.releaseControl(controlled.id, lease.id);
    await expect(manager.resize(controlled.id, lease.id, 90, 30)).rejects.toThrow(/valid control lease/);
  });

  it("bounds a slow observer and preserves reconstructable closure or disconnects deterministically", async () => {
    const transport = scriptedTransport();
    const manager = new TerminalManager({ maxBufferedFrames: 8, maxObserverQueueFrames: 3 });
    const session = manager.spawnTerminal({
      workerRunId: "accept-slow",
      title: "slow",
      command: "unused",
      transport,
      columns: 80,
      rows: 24,
    });
    const uninterrupted = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const iterator = manager.observe(session.id)[Symbol.asyncIterator]();
    await iterator.next();
    for (let index = 0; index < 500; index += 1) {
      const chunk = Buffer.from(line(index));
      transport.emit(chunk);
      await writeTerminal(uninterrupted, chunk);
    }
    transport.finish();
    await manager.whenIdle(session.id);
    const frames: TerminalFrame[] = [];
    for (;;) {
      const item = await iterator.next();
      if (item.done) break;
      frames.push(item.value);
    }

    expect(frames.length).toBeLessThanOrEqual(10);
    expect(frames.at(-1)?.type).toBe("closed");
    expect(await reconstruct(frames)).toBe(terminalDigest(uninterrupted));
  });

  it("input racing process death never raises an uncaught EPIPE or crashes the runner", async () => {
    const uncaught: unknown[] = [];
    const listener = (error: unknown) => uncaught.push(error);
    process.on("uncaughtException", listener);
    try {
      const manager = new TerminalManager();
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const session = manager.spawnTerminal({
          workerRunId: `accept-epipe-${String(attempt)}`,
          title: "cat",
          command: "cat",
        });
        const lease = await manager.acquireControl(session.id, "controller");
        await manager.sendInput(session.id, lease.id, Buffer.from("x"));
        manager.kill(session.id);
        await manager.sendInput(session.id, lease.id, Buffer.from("y")).catch(() => undefined);
        await manager.whenIdle(session.id);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", listener);
    }
  }, 15_000);

  it("never sequences or delivers transport output after terminal closure", async () => {
    const transport = scriptedTransport();
    const manager = new TerminalManager();
    const session = manager.spawnTerminal({
      workerRunId: "accept-close-order",
      title: "close order",
      command: "unused",
      transport,
    });
    const iterator = manager.observe(session.id)[Symbol.asyncIterator]();
    const first = await iterator.next();
    transport.emit("before");
    transport.finish();
    transport.emit("after");
    await manager.whenIdle(session.id);
    const frames = [first.value!];
    for (;;) {
      const item = await iterator.next();
      if (item.done) break;
      frames.push(item.value);
    }

    expect(frames.at(-1)?.type).toBe("closed");
    expect(sequences(frames)).toEqual([0, 1, 2]);
    expect(Buffer.concat(frames.filter((frame) => frame.type === "output").map(frameBytes))).toEqual(
      Buffer.from("before"),
    );
  });

  it("bounds a zero-byte resize flood and retains reconstructable final geometry and closure", async () => {
    const transport = scriptedTransport();
    const manager = new TerminalManager({ maxBufferedFrames: 16 });
    const session = manager.spawnTerminal({
      workerRunId: "accept-frame-flood",
      title: "frame flood",
      command: "unused",
      transport,
      columns: 80,
      rows: 24,
    });
    const lease = await manager.acquireControl(session.id, "controller");
    for (let index = 0; index < 200; index += 1) {
      await manager.resize(session.id, lease.id, 80 + (index % 5), 24 + (index % 3));
    }
    transport.finish();
    await manager.whenIdle(session.id);
    const frames = await collect(manager.observe(session.id, 0));

    expect(frames.length).toBeLessThanOrEqual(18);
    expect(frames[0]?.type).toBe("snapshot");
    expect(frames.at(-1)?.type).toBe("closed");
    expect(frames[0]?.sequence).toBeGreaterThan(0);
    expect(sequences(frames)).toEqual(frames.map((_, offset) => (frames[0]?.sequence ?? 0) + offset));
    const finalResize = frames.findLast(
      (frame): frame is Extract<TerminalFrame, { type: "resized" }> => frame.type === "resized",
    );
    expect(finalResize).toMatchObject({ columns: 84, rows: 25 });
  });

  it.each([
    ["zero", 0],
    ["NaN", Number.NaN],
    ["fractional", 0.5],
    ["negative", -3],
    ["maximum safe integer", Number.MAX_SAFE_INTEGER],
  ])("normalizes a %s observer queue bound without losing replay or closure", async (_, bound) => {
    const transport = scriptedTransport();
    const manager = new TerminalManager({ maxObserverQueueFrames: bound });
    const session = manager.spawnTerminal({
      workerRunId: "accept-normalized-observer-queue-bound",
      title: "normalized observer queue bound",
      command: "unused",
      transport,
    });

    transport.emit("retained output");
    transport.finish();
    await manager.whenIdle(session.id);

    const frames = await collect(manager.observe(session.id, 0));
    expect(frames.map((frame) => frame.type)).toEqual(["output", "closed"]);
    expect(Buffer.concat(frames.filter((frame) => frame.type === "output").map(frameBytes))).toEqual(
      Buffer.from("retained output"),
    );
  });

  it("never materializes a retained resize tail beyond the observer queue bound", async () => {
    const observerQueueBound = 2;
    const observedPeaks: Record<string, number> = {};
    for (const path of ["fresh late join", "existing observer resync"] as const) {
      const retainedResizeCount = 150;
      const transport = scriptedTransport();
      const manager = new TerminalManager({
        maxObserverQueueFrames: observerQueueBound,
        maxBufferedFrames: 200,
        maxBufferedBytes: 1024 * 1024,
      });
      const session = manager.spawnTerminal({
        workerRunId: `accept-bounded-replay-${path.replaceAll(" ", "-")}`,
        title: path,
        command: "unused",
        transport,
        columns: 80,
        rows: 24,
      });
      const uninterrupted = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
      const iterator = manager.observe(session.id)[Symbol.asyncIterator]();

      if (path === "existing observer resync") {
        const initial = await iterator.next();
        expect(initial.value).toMatchObject({ type: "snapshot", sequence: 0 });
        expect(soleObserverQueueDepth(manager, session.id)).toBeLessThanOrEqual(observerQueueBound);
      }

      const content = Buffer.from("quiescent");
      transport.emit(content);
      await writeTerminal(uninterrupted, content);
      await manager.whenIdle(session.id);
      const lease = await manager.acquireControl(session.id, "controller");
      for (let index = 0; index < retainedResizeCount; index += 1) {
        const columns = 80 + (index % 5);
        const rows = 24 + (index % 3);
        await manager.resize(session.id, lease.id, columns, rows);
        uninterrupted.resize(columns, rows);
      }
      transport.finish();
      await manager.whenIdle(session.id);

      const frames: TerminalFrame[] = [];
      const queueDepths: number[] = [];
      const drainCap = retainedResizeCount + 5;
      for (let pull = 0; pull < drainCap; pull += 1) {
        const item = await iterator.next();
        if (item.done) break;
        frames.push(item.value);
        queueDepths.push(soleObserverQueueDepth(manager, session.id));
        if (item.value.type === "closed") break;
      }

      expect(frames.at(-1)?.type, `${path} must terminate within ${String(drainCap)} pulls`).toBe("closed");
      expect(sequences(frames)).toEqual(frames.map((_, offset) => 1 + offset));
      expect(frames).toHaveLength(retainedResizeCount + 2);
      expect(frames.findLast((frame) => frame.type === "resized")).toMatchObject({
        columns: 84,
        rows: 26,
      });
      expect(await reconstruct(frames)).toBe(terminalDigest(uninterrupted));
      observedPeaks[path] = Math.max(...queueDepths);
    }
    for (const [path, peak] of Object.entries(observedPeaks))
      expect(
        peak,
        `observer queue peak for ${path} must stay within the configured bound; peaks=${JSON.stringify(observedPeaks)}`,
      ).toBeLessThanOrEqual(observerQueueBound);
  });

  it.each(parserBoundaryCases)(
    "keeps the snapshot behind an incomplete $name parser boundary",
    async (parserCase) => {
      const transport = scriptedTransport();
      const manager = new TerminalManager({ maxBufferedFrames: 1 });
      const session = manager.spawnTerminal({
        workerRunId: `accept-parser-${parserCase.name}`,
        title: parserCase.name,
        command: "unused",
        transport,
      });
      transport.emit("ground");
      await manager.whenIdle(session.id);
      transport.emit(parserCase.partial);
      await manager.whenIdle(session.id);
      const partial = await manager.observe(session.id)[Symbol.asyncIterator]().next();
      expect(partial.value?.sequence, `${parserCase.name} partial boundary`).toBe(1);

      transport.emit(parserCase.completion);
      await manager.whenIdle(session.id);
      const completed = await manager.observe(session.id)[Symbol.asyncIterator]().next();
      expect(completed.value?.sequence, `${parserCase.name} completed boundary`).toBe(3);
    },
  );

  it("supports real PTY input, echo and ordered exit under a live control lease", async () => {
    const manager = new TerminalManager();
    const session = manager.spawnTerminal({
      workerRunId: "accept-real-pty",
      title: "cat",
      command: "cat",
    });
    const lease = await manager.acquireControl(session.id, "controller");
    const iterator = manager.observe(session.id)[Symbol.asyncIterator]();
    const frames: TerminalFrame[] = [(await iterator.next()).value!];
    await manager.sendInput(session.id, lease.id, Buffer.from("ping\n"));
    for (;;) {
      const item = await iterator.next();
      if (item.done) break;
      frames.push(item.value);
      if (item.value.type === "output") manager.kill(session.id);
    }

    expect(Buffer.concat(frames.filter((frame) => frame.type === "output").map(frameBytes))).toEqual(
      Buffer.from("ping\r\n"),
    );
    expect(frames.at(-1)?.type).toBe("closed");
  }, 15_000);
});
