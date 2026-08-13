import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import type { TerminalFrame } from "@clankie/terminal-protocol";
import { TerminalManager, type TerminalTransport } from "./terminals.ts";

function transport() {
  let data: ((chunk: Buffer) => void) | undefined;
  let exit: ((code: number | null) => void) | undefined;
  let inputWrites = 0;
  return {
    emit: (bytes: Buffer | string) => data?.(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)),
    finish: (code = 0) => exit?.(code),
    get inputWrites() {
      return inputWrites;
    },
    write: () => {
      inputWrites += 1;
    },
    resize: () => undefined,
    kill: () => exit?.(null),
    onData: (listener: (chunk: Buffer) => void) => {
      data = listener;
    },
    onExit: (listener: (code: number | null) => void) => {
      exit = listener;
    },
  } satisfies TerminalTransport & {
    readonly inputWrites: number;
    emit(bytes: Buffer | string): void;
    finish(code?: number): void;
  };
}

async function collect(stream: AsyncIterable<TerminalFrame>): Promise<TerminalFrame[]> {
  const frames: TerminalFrame[] = [];
  for await (const frame of stream) frames.push(frame);
  return frames;
}

async function write(terminal: Terminal, bytes: Uint8Array): Promise<void> {
  await new Promise<void>((resolve) => terminal.write(bytes, resolve));
}

function digest(terminal: Terminal): string {
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  return createHash("sha256").update(serializer.serialize()).digest("hex");
}

async function reconstruct(
  frames: TerminalFrame[],
): Promise<{ digest: string; columns: number; rows: number }> {
  const snapshot = frames.find((frame) => frame.type === "snapshot");
  assert(snapshot?.type === "snapshot");
  const terminal = new Terminal({ cols: snapshot.columns, rows: snapshot.rows, allowProposedApi: true });
  await write(terminal, Buffer.from(snapshot.data, "base64"));
  for (const frame of frames.slice(frames.indexOf(snapshot) + 1)) {
    if (frame.type === "resized") terminal.resize(frame.columns, frame.rows);
    if (frame.type === "output") await write(terminal, Buffer.from(frame.data, "base64"));
  }
  return { digest: digest(terminal), columns: terminal.cols, rows: terminal.rows };
}

async function visualScenario() {
  const io = transport();
  const manager = new TerminalManager({ maxBufferedFrames: 32 });
  const session = manager.spawnTerminal({
    id: "fixture-visual",
    workerRunId: "fixture-visual",
    title: "visual",
    command: "unused",
    transport: io,
    columns: 80,
    rows: 24,
  });
  const uninterrupted = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const initial = Buffer.from("\u001b[?1049h\u001b[2J\u001b[31mRED\u001b[4;9H界\u001b[0m");
  io.emit(initial);
  await write(uninterrupted, initial);
  await manager.whenIdle(session.id);
  const lease = await manager.acquireControl(session.id, "fixture-controller");
  await manager.resize(session.id, lease.id, 40, 12);
  uninterrupted.resize(40, 12);
  const partialTail = Buffer.from("\u001b[6;3H€\u001b[");
  io.emit(partialTail);
  await write(uninterrupted, partialTail);
  await manager.whenIdle(session.id);
  const iterator = manager.observe(session.id)[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.value?.type, "snapshot");
  const completedTail = Buffer.from("?25l");
  io.emit(completedTail);
  await write(uninterrupted, completedTail);
  io.finish();
  await manager.whenIdle(session.id);
  const frames: TerminalFrame[] = [first.value!];
  for (;;) {
    const item = await iterator.next();
    if (item.done) break;
    frames.push(item.value);
  }
  const restored = await reconstruct(frames);
  assert.equal(restored.digest, digest(uninterrupted));
  assert.deepEqual(
    frames.map((frame) => frame.sequence),
    frames.map((_, index) => (frames[0]?.sequence ?? 0) + index),
  );
  assert.equal(frames.at(-1)?.type, "closed");
  return {
    alternateBuffer: true,
    color: "indexed-red",
    cursorAddressed: true,
    cursorHidden: true,
    unicodeScalars: 2,
    snapshotSequence: frames[0]?.sequence,
    tailSequences: frames.slice(1).map((frame) => frame.sequence),
    finalGeometry: { columns: restored.columns, rows: restored.rows },
    uninterruptedStateSha256: digest(uninterrupted),
    reconstructedStateSha256: restored.digest,
  };
}

async function slowConsumerScenario() {
  const io = transport();
  const manager = new TerminalManager({ maxBufferedFrames: 8, maxObserverQueueFrames: 3 });
  const session = manager.spawnTerminal({
    id: "fixture-slow",
    workerRunId: "fixture-slow",
    title: "slow",
    command: "unused",
    transport: io,
    columns: 80,
    rows: 24,
  });
  const uninterrupted = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  const iterator = manager.observe(session.id)[Symbol.asyncIterator]();
  await iterator.next();
  for (let index = 0; index < 500; index += 1) {
    const chunk = Buffer.from(`line-${String(index).padStart(4, "0")}\n`);
    io.emit(chunk);
    await write(uninterrupted, chunk);
  }
  io.finish();
  await manager.whenIdle(session.id);
  const frames: TerminalFrame[] = [];
  for (;;) {
    const item = await iterator.next();
    if (item.done) break;
    frames.push(item.value);
  }
  const restored = await reconstruct(frames);
  assert.ok(frames.length <= 10);
  assert.equal(frames.at(-1)?.type, "closed");
  assert.equal(restored.digest, digest(uninterrupted));
  return {
    emittedFrames: 500,
    deliveredFrames: frames.length,
    queueLimit: 3,
    outcome: "snapshot-resync-and-close",
    uninterruptedStateSha256: digest(uninterrupted),
    reconstructedStateSha256: restored.digest,
  };
}

async function leaseAndLifecycleScenario() {
  const transitions: string[] = [];
  const io = transport();
  const manager = new TerminalManager({
    onHumanControlChanged: (_workerRunId, active) => transitions.push(active ? "acquired" : "released"),
  });
  const session = manager.spawnTerminal({
    id: "fixture-lease",
    workerRunId: "fixture-lease",
    title: "lease",
    command: "unused",
    transport: io,
  });
  const observed = await manager.observe(session.id)[Symbol.asyncIterator]().next();
  assert.equal(observed.value?.type, "snapshot");
  await assert.rejects(manager.sendInput(session.id, "missing", Buffer.alloc(0)));
  const lease = await manager.acquireControl(session.id, "owner");
  await manager.sendInput(session.id, lease.id, Buffer.from("fixture-input"));
  assert.equal(io.inputWrites, 1);
  await assert.rejects(manager.acquireControl(session.id, "contender"));
  const previousExpiry = Date.parse(lease.expiresAt);
  const renewed = manager.renewControl(session.id, lease.id, 120_000);
  assert.ok(Date.parse(renewed.expiresAt) > previousExpiry);
  await manager.releaseControl(session.id, lease.id);
  await assert.rejects(manager.sendInput(session.id, lease.id, Buffer.alloc(0)));
  const expiring = await manager.acquireControl(session.id, "expiring-owner");
  manager.renewControl(session.id, expiring.id, -1);
  await assert.rejects(manager.sendInput(session.id, expiring.id, Buffer.alloc(0)));
  const replacement = await manager.acquireControl(session.id, "replacement");
  io.emit("closed-after-output");
  io.finish(7);
  await manager.whenIdle(session.id);
  await assert.rejects(manager.resize(session.id, replacement.id, 90, 30));
  const closed = await collect(manager.observe(session.id, 0));
  assert.deepEqual(
    closed.slice(-2).map((frame) => frame.type),
    ["output", "closed"],
  );

  const orphanIo = transport();
  const orphan = manager.spawnTerminal({
    id: "fixture-orphan",
    workerRunId: "fixture-orphan",
    title: "orphan",
    command: "unused",
    transport: orphanIo,
  });
  const orphanLease = await manager.acquireControl(orphan.id, "owner");
  assert.deepEqual(manager.closeOrphanedRecords(), [orphan.id]);
  assert.deepEqual(await manager.listSessions(), []);
  await assert.rejects(manager.sendInput(orphan.id, orphanLease.id, Buffer.alloc(0)));

  const observeLease = {
    id: "observe-only",
    terminalId: "fixture-observe-only",
    principalId: "watcher",
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    mode: "observe" as const,
  };
  const observeIo = transport();
  const observeOnly = new TerminalManager({
    leases: {
      acquire: () => observeLease,
      assert: () => observeLease,
      release: () => undefined,
      revoke: () => undefined,
      renew: () => observeLease,
      active: () => observeLease,
      expireStale: () => undefined,
    } as never,
  });
  const observeSession = observeOnly.spawnTerminal({
    id: observeLease.terminalId,
    workerRunId: "fixture-observe-only",
    title: "observe only",
    command: "unused",
    transport: observeIo,
  });
  await assert.rejects(observeOnly.sendInput(observeSession.id, observeLease.id, Buffer.alloc(0)));
  await assert.rejects(observeOnly.resize(observeSession.id, observeLease.id, 90, 30));
  return {
    observation: "lease-free",
    missingControl: "rejected",
    successfulControlInputCount: io.inputWrites,
    contention: "rejected",
    positiveRenewal: "accepted",
    explicitRelease: "accepted",
    staleAfterRelease: "rejected",
    expiredControl: "rejected",
    observeOnlyInput: "rejected",
    observeOnlyResize: "rejected",
    processExitCode: 7,
    outputCloseOrder: closed.slice(-2).map((frame) => frame.type),
    handoffTransitions: transitions,
    restartOrphansClosed: 1,
    discoveryAfterRestart: 0,
    orphanLeaseAfterRestart: "revoked",
  };
}

async function nativePtyScenario() {
  const manager = new TerminalManager();
  const expectedColumns = 73;
  const expectedRows = 19;
  const program = [
    "const tty = process.stdin.isTTY && process.stdout.isTTY;",
    "process.stdout.write(`READY:${tty}:${process.stdout.columns}:${process.stdout.rows}\\n`);",
    "process.stdin.once('data', () => { process.stdout.write('RESPONSE\\n'); process.exit(0); });",
  ].join("");
  const session = manager.spawnTerminal({
    id: "fixture-native-pty",
    workerRunId: "fixture-native-pty",
    title: "native PTY",
    command: process.execPath,
    args: ["-e", program],
    columns: expectedColumns,
    rows: expectedRows,
  });
  const lease = await manager.acquireControl(session.id, "native-controller");
  const framesPromise = collect(manager.observe(session.id));
  await manager.sendInput(session.id, lease.id, Buffer.from("trigger\n"));
  const frames = await framesPromise;
  const output = Buffer.concat(
    frames
      .filter((frame): frame is Extract<TerminalFrame, { type: "output" }> => frame.type === "output")
      .map((frame) => Buffer.from(frame.data, "base64")),
  );
  assert.match(output.toString("utf8"), /READY:true:73:19/u);
  assert.match(output.toString("utf8"), /RESPONSE/u);
  const closure = frames.at(-1);
  assert(closure?.type === "closed");
  assert.equal(closure.exitCode, 0);
  assert.equal(session.provider, "native_pty");
  assert.deepEqual(manager.context(session.id), {
    missionId: "local",
    taskId: "local",
    workerRunId: "fixture-native-pty",
    attempt: 1,
    provider: "native_pty",
    source: "runner_pty",
  });
  return {
    provider: session.provider,
    source: manager.context(session.id).source,
    ttyIdentity: "stdin-and-stdout-tty",
    geometry: { columns: expectedColumns, rows: expectedRows },
    successfulInputCount: 1,
    inputTriggeredResponse: "observed",
    outputFrameCount: frames.filter((frame) => frame.type === "output").length,
    outputByteCount: output.byteLength,
    outputSha256: createHash("sha256").update(output).digest("hex"),
    ordering: frames.slice(-2).map((frame) => frame.type),
    exitCode: 0,
  };
}

export const artifact = {
  schemaVersion: 1,
  fixture: "runner-terminal-lifecycle",
  visualReconnect: await visualScenario(),
  burstSlowConsumer: await slowConsumerScenario(),
  leaseExitRestart: await leaseAndLifecycleScenario(),
  nativePty: await nativePtyScenario(),
  safeDataPolicy: "sanitized counts, enums, geometry, sequences, and state hashes only",
};
assert.equal(
  artifact.visualReconnect.uninterruptedStateSha256,
  artifact.visualReconnect.reconstructedStateSha256,
);
assert.equal(artifact.burstSlowConsumer.outcome, "snapshot-resync-and-close");
assert.deepEqual(artifact.leaseExitRestart.outputCloseOrder, ["output", "closed"]);
assert.equal(artifact.leaseExitRestart.successfulControlInputCount, 1);
assert.equal(artifact.leaseExitRestart.positiveRenewal, "accepted");
assert.equal(artifact.leaseExitRestart.explicitRelease, "accepted");
assert.equal(artifact.leaseExitRestart.staleAfterRelease, "rejected");
assert.equal(artifact.leaseExitRestart.observeOnlyInput, "rejected");
assert.equal(artifact.nativePty.provider, "native_pty");
assert.equal(artifact.nativePty.inputTriggeredResponse, "observed");
assert.deepEqual(artifact.nativePty.ordering, ["output", "closed"]);

const outputPath = resolve(
  process.argv[2] ??
    resolve(
      import.meta.dirname,
      "../../../artifacts/runner/terminal-lifecycle/terminal-lifecycle-evidence.json",
    ),
);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${outputPath}\n`);
