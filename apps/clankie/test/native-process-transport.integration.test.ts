import { mkdtemp, readFile, writeFile, chmod, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  nativeProcessRequest,
  closeNativeProcessObservers,
  type NativeTransportReason,
} from "../src/native-process-transport.ts";
import { fleetProcessHelper } from "../src/local-fleet-process.ts";

const roots: string[] = [];
interface Journal {
  kind: string;
  pid: number;
  id?: number;
  mode?: string;
  argv?: string[];
  holderPid?: number;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};
async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-native-pipe-"));
  roots.push(root);
  const helper = join(root, "helper.mjs");
  const source = await readFile(
    new URL("./helpers/native-process-transport/fixture.mjs", import.meta.url),
    "utf8",
  );
  await writeFile(helper, `#!${process.execPath}\n${source}`);
  await chmod(helper, 0o700);
  const journal = async (): Promise<Journal[]> => {
    const text = await readFile(join(root, "journal.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Journal);
  };
  return {
    helper,
    root,
    journal,
    received: () =>
      until(journal, (rows) => rows.some((row) => row.kind === "request"), "helper received request"),
    release: () => writeFile(join(root, "release"), "release\n"),
  };
}
afterEach(async () => {
  await closeNativeProcessObservers();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
// POSIX executable shebang fixtures; no native build, Herdr daemon, or full process census.
const pipeIt = it.skipIf(process.platform === "win32");

pipeIt("serializes two fresh requests and a native refusal through one real child", async () => {
  const f = await fixture();
  const [first, second, refused] = await Promise.all([
    nativeProcessRequest(f.helper, ["echo-first"]),
    nativeProcessRequest(f.helper, ["echo-second"]),
    nativeProcessRequest(f.helper, ["refuse"]),
  ]);
  const a = JSON.parse(first!.stdout);
  const b = JSON.parse(second!.stdout);
  expect(a).toMatchObject({ mode: "echo-first", sequence: 1 });
  expect(b).toMatchObject({ pid: a.pid, mode: "echo-second", sequence: 2 });
  expect(refused).toEqual({ stdout: "", stderr: "fixed refusal diagnostic\n" });
  expect((await f.journal()).filter((row) => row.kind === "start")).toHaveLength(1);
  expect(alive(a.pid)).toBe(true);
  await closeNativeProcessObservers();
  expect(alive(a.pid)).toBe(false);
});

pipeIt.each(["wrong-id", "extra-frame", "oversized", "stderr", "dead"])(
  "closes the actual child on %s, releases queued work only after close, and does not replay",
  async (mode) => {
    const f = await fixture();
    const reasons: NativeTransportReason[] = [];
    const first = nativeProcessRequest(f.helper, [mode], undefined, (reason) => reasons.push(reason));
    const queued = nativeProcessRequest(f.helper, ["must-not-dispatch"], undefined, (reason) =>
      reasons.push(reason),
    );
    const rows = await f.received();
    const pid = rows[0]!.pid;
    expect(await first).toBeUndefined();
    expect(alive(pid)).toBe(false);
    expect(await queued).toBeUndefined();
    expect(reasons).toEqual([
      mode === "dead" ? "helper_unavailable" : "protocol_invalid",
      mode === "dead" ? "helper_unavailable" : "protocol_invalid",
    ]);
    expect((await f.journal()).filter((row) => row.kind === "request").map((row) => row.mode)).toEqual([
      mode,
    ]);
    const manual = await nativeProcessRequest(f.helper, ["explicit-new-call"]);
    expect(JSON.parse(manual!.stdout)).toMatchObject({ mode: "explicit-new-call", sequence: 1 });
    const final = await f.journal();
    expect(final.filter((row) => row.kind === "start")).toHaveLength(2);
    expect(final.filter((row) => row.kind === "request").map((row) => row.mode)).toEqual([
      mode,
      "explicit-new-call",
    ]);
  },
);

pipeIt("waits for inherited stdout/stderr to close after the helper PID has already exited", async () => {
  const f = await fixture();
  let settled = false;
  let queuedSettled = false;
  const pending = nativeProcessRequest(f.helper, ["exit-with-held-pipes"]).then((value) => {
    settled = true;
    return value;
  });
  const queued = nativeProcessRequest(f.helper, ["must-not-dispatch"]).then((value) => {
    queuedSettled = true;
    return value;
  });
  const rows = await until(
    f.journal,
    (entries) => entries.some((entry) => entry.kind === "holder"),
    "real inherited pipe holder",
  );
  const holder = rows.find((entry) => entry.kind === "holder")!;
  await until(
    async () => alive(holder.pid),
    (value) => !value,
    "original helper kernel absence",
  );
  expect(alive(holder.holderPid!)).toBe(true);
  expect(settled).toBe(false);
  expect(queuedSettled).toBe(false);
  expect(await pending).toBeUndefined();
  expect(await queued).toBeUndefined();
  expect(alive(holder.pid)).toBe(false);
  // The inherited pipe holder has exited when close fires; no successor request is dispatched.
  expect((await f.journal()).filter((row) => row.kind === "request")).toHaveLength(1);
});

pipeIt("bounds a silent real child by the production deadline and waits for its death", async () => {
  const f = await fixture();
  const reasons: NativeTransportReason[] = [];
  const began = performance.now();
  const pending = nativeProcessRequest(f.helper, ["timeout"], undefined, (reason) => reasons.push(reason));
  const pid = (await f.received())[0]!.pid;
  expect(await pending).toBeUndefined();
  expect(performance.now() - began).toBeLessThan(3_000);
  expect(reasons).toEqual(["timeout"]);
  expect(alive(pid)).toBe(false);
  expect((await f.journal()).filter((row) => row.kind === "request")).toHaveLength(1);
});

pipeIt(
  "drains a cancelled active proof before releasing it and serves other callers through the same child",
  async () => {
    const f = await fixture();
    const signal = new AbortController();
    const reasons: NativeTransportReason[] = [];
    let settled = false;
    const active = nativeProcessRequest(f.helper, ["hold"], signal.signal, (reason) =>
      reasons.push(reason),
    ).then((value) => {
      settled = true;
      return value;
    });
    const pid = (await f.received())[0]!.pid;
    const queued = nativeProcessRequest(f.helper, ["independent-proof"], undefined, (reason) =>
      reasons.push(reason),
    );
    signal.abort();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    expect(alive(pid)).toBe(true);
    expect((await f.journal()).filter((row) => row.kind === "request")).toHaveLength(1);
    await f.release();
    expect(await active).toBeUndefined();
    expect(JSON.parse((await queued)!.stdout)).toMatchObject({ pid, mode: "independent-proof", sequence: 2 });
    expect(alive(pid)).toBe(true);
    expect(reasons).toEqual(["cancelled"]);
    expect((await f.journal()).filter((row) => row.kind === "request").map((row) => row.mode)).toEqual([
      "hold",
      "independent-proof",
    ]);
  },
);

pipeIt("starts each timeout at dispatch, even after waiting longer than a proof deadline", async () => {
  const f = await fixture();
  const reasons: NativeTransportReason[] = [];
  const began = performance.now();
  const replies = await Promise.all(
    [1, 2, 3].map(() =>
      nativeProcessRequest(f.helper, ["slow"], undefined, (reason) => reasons.push(reason)),
    ),
  );
  expect(performance.now() - began).toBeGreaterThan(1_500);
  const values = replies.map((reply) => JSON.parse(reply!.stdout));
  expect(values.map((value) => value.sequence)).toEqual([1, 2, 3]);
  expect(new Set(values.map((value) => value.pid)).size).toBe(1);
  expect(reasons).toEqual([]);
  expect((await f.journal()).filter((row) => row.kind === "start")).toHaveLength(1);
});

pipeIt("still kills a stalled helper at its active deadline after caller cancellation", async () => {
  const f = await fixture();
  const signal = new AbortController();
  const reasons: NativeTransportReason[] = [];
  const active = nativeProcessRequest(f.helper, ["timeout"], signal.signal, (reason) => reasons.push(reason));
  const pid = (await f.received())[0]!.pid;
  const queued = nativeProcessRequest(f.helper, ["must-not-dispatch"], undefined, (reason) =>
    reasons.push(reason),
  );
  signal.abort();
  expect(await active).toBeUndefined();
  expect(await queued).toBeUndefined();
  expect(alive(pid)).toBe(false);
  expect(reasons).toEqual(["cancelled", "timeout"]);
  expect((await f.journal()).filter((row) => row.kind === "request")).toHaveLength(1);
});

pipeIt(
  "cancels only a queued job while the active child remains alive and serves the next explicit job",
  async () => {
    const f = await fixture();
    const active = nativeProcessRequest(f.helper, ["hold"]);
    const pid = (await f.received())[0]!.pid;
    const signal = new AbortController();
    const reasons: NativeTransportReason[] = [];
    const queued = nativeProcessRequest(f.helper, ["must-not-dispatch"], signal.signal, (reason) =>
      reasons.push(reason),
    );
    signal.abort();
    expect(await queued).toBeUndefined();
    expect(reasons).toEqual(["cancelled"]);
    expect(alive(pid)).toBe(true);
    const next = nativeProcessRequest(f.helper, ["echo-next"]);
    await f.release();
    expect(JSON.parse((await active)!.stdout)).toMatchObject({ pid, sequence: 1 });
    expect(JSON.parse((await next)!.stdout)).toMatchObject({ pid, sequence: 2, mode: "echo-next" });
    expect((await f.journal()).filter((row) => row.kind === "request").map((row) => row.id)).toEqual([1, 3]);
  },
);

pipeIt(
  "finishes an idle transport close in a standalone Node process without test-runner keepalives",
  async () => {
    const f = await fixture();
    const driver = fileURLToPath(
      new URL("./helpers/native-process-transport/close-driver.mjs", import.meta.url),
    );
    const transport = fileURLToPath(new URL("../src/native-process-transport.ts", import.meta.url));
    // execFile rejects nonzero exit, including Node's unsettled top-level-await exit13.
    const { stdout } = await promisify(execFile)(process.execPath, [driver, transport, f.helper], {
      timeout: 5_000,
    });
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ completed: true, absent: true });
    expect(alive(result.helperPid)).toBe(false);
    expect((await f.journal()).filter((row) => row.kind === "request").map((row) => row.mode)).toEqual([
      "idle-before-close",
    ]);
  },
);

it.skipIf(process.platform !== "darwin" || process.env.FLEET_PROOF_NATIVE_TEST !== "1")(
  "reads the actual calling process birth through the compiled helper's persistent pipe",
  async () => {
    const helper = fleetProcessHelper(fileURLToPath(new URL("../../../", import.meta.url)));
    await access(helper);
    const response = await nativeProcessRequest(helper, ["--birth", String(process.pid)]);
    const value = JSON.parse(response!.stdout);
    expect(value).toMatchObject({ schemaVersion: 1, process: { pid: process.pid, uid: process.getuid!() } });
    expect(value.process.birth).toHaveLength(2);
    expect(
      value.process.birth.every((part: unknown) => typeof part === "string" && /^\d+$/u.test(part)),
    ).toBe(true);
  },
);
