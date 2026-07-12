import { decodeTerminalBytes, type TerminalFrame } from "@clankie/terminal-protocol";
import { describe, expect, it } from "vitest";
import { TerminalManager, type TerminalTransport } from "../src/terminals.ts";

/** Scripted transport: the test drives output deterministically. */
function scriptedTransport(): TerminalTransport & {
  emit: (text: string) => void;
  exit: (code: number | null) => void;
  writes: string[];
} {
  let dataListener: ((chunk: Buffer) => void) | undefined;
  let exitListener: ((code: number | null) => void) | undefined;
  const writes: string[] = [];
  return {
    writes,
    emit: (text) => dataListener?.(Buffer.from(text, "utf8")),
    exit: (code) => exitListener?.(code),
    write: (bytes) => writes.push(Buffer.from(bytes).toString("utf8")),
    resize: () => undefined,
    kill: () => exitListener?.(null),
    onData: (listener) => {
      dataListener = listener;
    },
    onExit: (listener) => {
      exitListener = listener;
    },
  };
}

function outputText(frame: TerminalFrame): string {
  return frame.type === "output" || frame.type === "snapshot"
    ? Buffer.from(decodeTerminalBytes(frame.data)).toString("utf8")
    : "";
}

async function collect(
  frames: AsyncIterable<TerminalFrame>,
  stopAfter?: (frame: TerminalFrame) => boolean,
): Promise<TerminalFrame[]> {
  const seen: TerminalFrame[] = [];
  for await (const frame of frames) {
    seen.push(frame);
    if (stopAfter?.(frame)) break;
  }
  return seen;
}

const line = (index: number) => `line-${String(index).padStart(6, "0")}\n`;

describe("TerminalManager", () => {
  it("restores a stable terminal identity without allowing duplicate ownership", () => {
    const manager = new TerminalManager();
    const restored = manager.spawnTerminal({
      id: "terminal-run-1",
      workerRunId: "run-1",
      title: "restored",
      command: "unused",
      transport: scriptedTransport(),
    });

    expect(restored.id).toBe("terminal-run-1");
    expect(() =>
      manager.spawnTerminal({
        id: restored.id,
        workerRunId: "run-2",
        title: "duplicate",
        command: "unused",
        transport: scriptedTransport(),
      }),
    ).toThrow(/already exists/);
  });

  it("resumes mid-stream reconnects gap-free with no duplicated or lost bytes", async () => {
    const transport = scriptedTransport();
    const manager = new TerminalManager();
    const session = manager.spawnTerminal({
      workerRunId: "run-1",
      title: "scripted",
      command: "unused",
      transport,
    });

    for (let index = 0; index < 50; index += 1) transport.emit(line(index));
    // First connection: read until sequence 30, then "disconnect".
    const first = await collect(manager.observe(session.id), (frame) => frame.sequence === 30);
    const firstText = first.map(outputText).join("");
    expect(first.at(-1)?.sequence).toBe(30);

    for (let index = 50; index < 80; index += 1) transport.emit(line(index));
    transport.exit(0);

    // Reconnect from the last seen sequence: no snapshot, no gaps, no repeats.
    const resumed = await collect(manager.observe(session.id, 30));
    expect(resumed[0]?.type).toBe("output");
    expect(resumed[0]?.sequence).toBe(31);
    const sequences = resumed.map((frame) => frame.sequence);
    expect(sequences).toEqual(sequences.map((_, offset) => 31 + offset));
    expect(resumed.at(-1)?.type).toBe("closed");

    const fullText = Array.from({ length: 80 }, (_, index) => line(index)).join("");
    expect(firstText + resumed.map(outputText).join("")).toBe(fullText);
  });

  it("resyncs late joiners beyond the buffer from a snapshot plus contiguous tail", async () => {
    const transport = scriptedTransport();
    const manager = new TerminalManager({ maxBufferedBytes: 1024, maxSnapshotBytes: 512 });
    const session = manager.spawnTerminal({
      workerRunId: "run-2",
      title: "scripted",
      command: "unused",
      transport,
    });

    const total = 200; // 200 × 12 bytes ≫ 1 KiB buffer: forces eviction.
    for (let index = 0; index < total; index += 1) transport.emit(line(index));
    transport.exit(0);

    // fromSequence=5 fell out of the buffer long ago → snapshot resync.
    const frames = await collect(manager.observe(session.id, 5));
    expect(frames[0]?.type).toBe("snapshot");
    const snapshot = frames[0] as Extract<TerminalFrame, { type: "snapshot" }>;
    expect(Buffer.from(snapshot.data, "base64").byteLength).toBeLessThanOrEqual(512);
    const tail = frames.slice(1);
    expect(tail.map((frame) => frame.sequence)).toEqual(
      tail.map((_, offset) => snapshot.sequence + 1 + offset),
    );
    // Snapshot bytes + buffered bytes reproduce the exact end of the stream.
    const replayed = frames.map(outputText).join("");
    const fullText = Array.from({ length: total }, (_, index) => line(index)).join("");
    expect(replayed).toBe(fullText.slice(fullText.length - replayed.length));
    expect(replayed.length).toBeGreaterThan(0);
  });

  it("replays a scripted high-throughput session byte-exactly for a live observer", async () => {
    const manager = new TerminalManager();
    const total = 20_000;
    const script = `for (let i = 0; i < ${String(total)}; i += 1) process.stdout.write(\`line-\${String(i).padStart(6, "0")}\\n\`);`;
    const session = manager.spawnTerminal({
      workerRunId: "run-3",
      title: "high-throughput",
      command: process.execPath,
      args: ["-e", script],
    });

    const frames = await collect(manager.observe(session.id));
    const closed = frames.at(-1);
    expect(closed?.type).toBe("closed");
    expect((closed as Extract<TerminalFrame, { type: "closed" }>).exitCode).toBe(0);
    const sequences = frames.map((frame) => frame.sequence);
    expect(sequences).toEqual(sequences.map((_, offset) => (sequences[0] as number) + offset));
    const text = frames.map(outputText).join("");
    expect(text).toBe(Array.from({ length: total }, (_, index) => line(index)).join(""));
  }, 30_000);

  it("enforces observe vs control at the protocol layer", async () => {
    const transport = scriptedTransport();
    const manager = new TerminalManager();
    const session = manager.spawnTerminal({
      workerRunId: "run-4",
      title: "scripted",
      command: "unused",
      transport,
    });

    // Observation requires no lease; input without a lease is rejected.
    await expect(manager.sendInput(session.id, "no-such-lease", Buffer.from("x"))).rejects.toThrow(
      /valid control lease/,
    );

    const lease = await manager.acquireControl(session.id, "principal-a");
    expect(lease.mode).toBe("control");
    await manager.sendInput(session.id, lease.id, Buffer.from("echo hi\n"));
    expect(transport.writes).toEqual(["echo hi\n"]);

    // A second principal cannot take control while the lease is held.
    await expect(manager.acquireControl(session.id, "principal-b")).rejects.toThrow(
      /controlled by principal-a/,
    );

    await manager.releaseControl(session.id, lease.id);
    await expect(manager.sendInput(session.id, lease.id, Buffer.from("x"))).rejects.toThrow(
      /valid control lease/,
    );
  });

  it("rejects input under an observe-mode lease", async () => {
    const transport = scriptedTransport();
    const observeLease = {
      id: "lease-observe",
      terminalId: "",
      principalId: "watcher",
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      mode: "observe" as const,
    };
    const leases = {
      acquire: () => observeLease,
      assert: () => observeLease,
      release: () => undefined,
      expireStale: () => undefined,
    };
    const manager = new TerminalManager({ leases: leases as never });
    const session = manager.spawnTerminal({
      workerRunId: "run-5",
      title: "scripted",
      command: "unused",
      transport,
    });
    await expect(manager.sendInput(session.id, observeLease.id, Buffer.from("x"))).rejects.toThrow(
      /observe-only; input requires a control lease/,
    );
    expect(transport.writes).toEqual([]);
  });

  it("resyncs a lagging observer from a snapshot instead of buffering unbounded frames", async () => {
    const transport = scriptedTransport();
    const manager = new TerminalManager({
      maxObserverQueueFrames: 8,
      maxBufferedBytes: 1024,
      maxSnapshotBytes: 512,
    });
    const session = manager.spawnTerminal({
      workerRunId: "run-6",
      title: "scripted",
      command: "unused",
      transport,
    });

    const iterator = manager.observe(session.id)[Symbol.asyncIterator]();
    // Register the observer (first pull awaits the first frame), then flood.
    const firstPull = iterator.next();
    for (let index = 0; index < 500; index += 1) transport.emit(line(index));
    transport.exit(0);

    const frames: TerminalFrame[] = [await firstPull.then((result) => result.value as TerminalFrame)];
    while (true) {
      const result = await iterator.next();
      if (result.done) break;
      frames.push(result.value);
      if (result.value.type === "closed") break;
    }
    // The first pull yields the initial (pre-flood) snapshot; the flood must
    // have forced at least one later resync snapshot.
    const snapshotIndex = frames.findLastIndex((frame) => frame.type === "snapshot");
    expect(snapshotIndex).toBeGreaterThan(0);
    const afterSnapshot = frames.slice(snapshotIndex);
    const sequences = afterSnapshot.slice(1).map((frame) => frame.sequence);
    expect(sequences).toEqual(
      sequences.map((_, offset) => (afterSnapshot[0] as TerminalFrame).sequence + 1 + offset),
    );
    // Replay after the resync point matches the true end of the stream.
    const replayed = afterSnapshot.map(outputText).join("");
    const fullText = Array.from({ length: 500 }, (_, index) => line(index)).join("");
    expect(replayed).toBe(fullText.slice(fullText.length - replayed.length));
    expect(frames.at(-1)?.type).toBe("closed");
  });

  it("labels pipe-backed sessions generic, not native_pty", async () => {
    const transport = scriptedTransport();
    const manager = new TerminalManager();
    const session = manager.spawnTerminal({
      workerRunId: "run-8",
      title: "scripted",
      command: "unused",
      transport,
    });
    expect(session.provider).toBe("generic");
  });

  it("survives input racing terminal death without crashing the runner", async () => {
    const manager = new TerminalManager();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const session = manager.spawnTerminal({
        workerRunId: `run-epipe-${String(attempt)}`,
        title: "cat",
        command: "cat",
      });
      const lease = await manager.acquireControl(session.id, "principal-a");
      await manager.sendInput(session.id, lease.id, Buffer.from("x"));
      manager.kill(session.id);
      // The kill and the exit event race this write; it may resolve or reject,
      // but it must never raise an uncaught EPIPE.
      await manager.sendInput(session.id, lease.id, Buffer.from("y")).catch(() => undefined);
      await manager.releaseControl(session.id, lease.id);
    }
  }, 15_000);

  it("drops transport output arriving after exit instead of sequencing it past closed", async () => {
    const transport = scriptedTransport();
    const manager = new TerminalManager();
    const session = manager.spawnTerminal({
      workerRunId: "run-9",
      title: "scripted",
      command: "unused",
      transport,
    });
    transport.emit("before-");
    transport.exit(0);
    transport.emit("after");

    const frames = await collect(manager.observe(session.id));
    expect(frames.at(-1)?.type).toBe("closed");
    expect(frames.map(outputText).join("")).toBe("before-");
  });

  it("bounds the replay buffer by frame count under a zero-byte frame flood", async () => {
    const transport = scriptedTransport();
    const manager = new TerminalManager({ maxBufferedFrames: 16 });
    const session = manager.spawnTerminal({
      workerRunId: "run-10",
      title: "scripted",
      command: "unused",
      transport,
    });
    const lease = await manager.acquireControl(session.id, "principal-a");
    for (let index = 0; index < 200; index += 1) {
      await manager.resize(session.id, lease.id, 80 + (index % 5), 24);
    }
    transport.exit(0);
    const frames = await collect(manager.observe(session.id));
    // Snapshot + at most maxBufferedFrames buffered frames (incl. closed).
    expect(frames.length).toBeLessThanOrEqual(18);
    expect(frames[0]?.type).toBe("snapshot");
    expect(frames.at(-1)?.type).toBe("closed");
  });

  it("echoes input through a real process under a control lease", async () => {
    const manager = new TerminalManager();
    const session = manager.spawnTerminal({
      workerRunId: "run-7",
      title: "cat",
      command: "cat",
    });
    const lease = await manager.acquireControl(session.id, "principal-a");
    await manager.sendInput(session.id, lease.id, Buffer.from("ping\n"));
    const frames: TerminalFrame[] = [];
    for await (const frame of manager.observe(session.id)) {
      frames.push(frame);
      if (frame.type === "output") manager.kill(session.id);
      if (frame.type === "closed") break;
    }
    expect(frames.map(outputText).join("")).toBe("ping\n");
  }, 15_000);
});
