import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ClankieApiClient } from "@clankie/api-client";

interface ReplayFrame {
  type: "snapshot" | "output" | "resized" | "closed";
  terminalId: string;
  sequence: number;
  data?: string;
}

interface ReplayTerminal {
  terminalId: string;
  workerRunId: string;
  throughSequence: number;
  frames: ReplayFrame[];
}

interface ReplayResponse {
  terminals: ReplayTerminal[];
}

export interface ConsoleTerminalSnapshot {
  terminalId: string;
  workerRunId: string;
  lastSequence: number;
  bytes: string;
  resumedFromSequence?: number;
  receivedSequences: number[];
}

export interface ConsoleRecoverySnapshot {
  schemaVersion: 1;
  client: "@clankie/tui recovery probe";
  mission: unknown;
  terminals: ConsoleTerminalSnapshot[];
}

export interface RecoveryProbeOptions {
  baseUrl: string;
  missionId: string;
  replayUrl: string;
  outputPath: string;
  resumePath?: string;
}

function decodeBytes(value: string | undefined): Buffer {
  return Buffer.from(value ?? "", "base64");
}

export function applyTerminalReplay(
  replay: ReplayTerminal,
  previous?: ConsoleTerminalSnapshot,
): ConsoleTerminalSnapshot {
  let sequence = previous?.lastSequence ?? -1;
  let bytes = decodeBytes(previous?.bytes);
  const receivedSequences: number[] = [];

  for (const frame of replay.frames) {
    assert.equal(frame.terminalId, replay.terminalId, "replay frame belongs to another terminal");
    if (frame.type === "snapshot") {
      assert(frame.sequence >= sequence, "terminal snapshot moved the cursor backwards");
      sequence = frame.sequence;
      bytes = decodeBytes(frame.data);
    } else {
      assert.equal(frame.sequence, sequence + 1, "terminal replay contains a sequence gap");
      sequence = frame.sequence;
      if (frame.type === "output") bytes = Buffer.concat([bytes, decodeBytes(frame.data)]);
    }
    receivedSequences.push(frame.sequence);
  }

  assert.equal(sequence, replay.throughSequence, "terminal replay stopped before its declared horizon");
  return {
    terminalId: replay.terminalId,
    workerRunId: replay.workerRunId,
    lastSequence: sequence,
    bytes: bytes.toString("base64"),
    ...(previous === undefined ? {} : { resumedFromSequence: previous.lastSequence }),
    receivedSequences,
  };
}

async function readCheckpoint(path: string | undefined): Promise<ConsoleRecoverySnapshot | undefined> {
  if (path === undefined) return undefined;
  return JSON.parse(await readFile(path, "utf8")) as ConsoleRecoverySnapshot;
}

async function writeCheckpoint(path: string, snapshot: ConsoleRecoverySnapshot): Promise<void> {
  const temporaryPath = join(dirname(path), `.${process.pid.toString()}-recovery-probe.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

export async function captureRecoverySnapshot(
  options: RecoveryProbeOptions,
): Promise<ConsoleRecoverySnapshot> {
  const previous = await readCheckpoint(options.resumePath);
  const previousByTerminal = new Map(
    previous?.terminals.map((terminal) => [terminal.terminalId, terminal]) ?? [],
  );
  const cursors = Object.fromEntries(
    [...previousByTerminal].map(([terminalId, terminal]) => [terminalId, terminal.lastSequence]),
  );
  const [mission, replayResponse] = await Promise.all([
    new ClankieApiClient({ baseUrl: options.baseUrl }).getMission(options.missionId),
    fetch(options.replayUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cursors }),
    }),
  ]);
  assert(replayResponse.ok, `terminal replay request failed with ${replayResponse.status.toString()}`);
  const replay = (await replayResponse.json()) as ReplayResponse;
  const terminals = replay.terminals.map((terminal) =>
    applyTerminalReplay(terminal, previousByTerminal.get(terminal.terminalId)),
  );
  assert.equal(terminals.length, 3, "M1 recovery probe requires exactly three terminals");

  const snapshot: ConsoleRecoverySnapshot = {
    schemaVersion: 1,
    client: "@clankie/tui recovery probe",
    mission,
    terminals,
  };
  await writeCheckpoint(options.outputPath, snapshot);
  return snapshot;
}

function requiredArgument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  assert(value, `recovery probe requires ${name}`);
  return value;
}

export async function runRecoveryProbe(): Promise<never> {
  await captureRecoverySnapshot({
    baseUrl: requiredArgument("--base-url"),
    missionId: requiredArgument("--mission-id"),
    replayUrl: requiredArgument("--replay-url"),
    outputPath: requiredArgument("--output"),
    ...(process.argv.includes("--resume-from") ? { resumePath: requiredArgument("--resume-from") } : {}),
  });
  process.stdout.write("clankie: recovery checkpoint ready\n");
  return new Promise<never>(() => {
    setInterval(() => undefined, 60_000);
  });
}
