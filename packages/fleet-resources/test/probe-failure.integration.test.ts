import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createResourceGovernor } from "../src/governor.ts";
import { defaultResourcePolicy } from "../src/model.ts";
import {
  observeProcesses,
  probeProcess,
  processIdentity,
  processSnapshot,
  resourceNativeHelperPath,
  resourcePython,
} from "../src/process.ts";

const execute = promisify(execFile);

/** Fixture native read failures, with real subprocesses and kernel liveness checks. */
async function deniedProbe(mode: "darwin-read" | "linux-read" | "darwin-owner") {
  const directory = await mkdtemp(join(tmpdir(), "clankie-process-denied-"));
  try {
    await copyFile(join(import.meta.dirname, "../src/process.ts"), join(directory, "process.ts"));
    await writeFile(
      join(directory, "native.py"),
      `import ctypes, os, runpy, sys
mode = ${JSON.stringify(mode)}
if mode == "linux-read":
    sys.platform = "linux"
    original_stat = os.stat
    def denied_stat(path, *args, **kwargs):
        if path == "/proc/" + str(os.getppid()):
            raise PermissionError("fixture process read denied")
        return original_stat(path, *args, **kwargs)
    os.stat = denied_stat
else:
    sys.platform = "darwin"
    class ReadFixture:
        def __call__(self, pid, flavor, argument, pointer, size):
            if mode == "darwin-owner":
                info = pointer._obj
                info.uid = os.getuid() + 1
                info.ruid = os.getuid() + 1
                return size
            return 0
    class LibraryFixture:
        proc_pidinfo = ReadFixture()
    ctypes.CDLL = lambda *args, **kwargs: LibraryFixture()
runpy.run_path(${JSON.stringify(resourceNativeHelperPath())}, run_name="__main__")
`,
    );
    const driver = join(directory, "driver.mjs");
    await writeFile(
      driver,
      `import {observeProcesses,probeProcess,processSnapshot} from ${JSON.stringify(pathToFileURL(join(directory, "process.ts")).href)};
process.kill(process.pid,0);
const probe=await probeProcess({pid:process.pid,startTime:"recorded-incarnation"});
const batchStatus=(await observeProcesses([process.pid])).get(process.pid).status;
let snapshotFailed=false;
try {await processSnapshot()} catch {snapshotFailed=true}
process.kill(process.pid,0);
console.log(JSON.stringify({probe,batchStatus,snapshotFailed,live:true}));
`,
    );
    const { stdout } = await execute(process.execPath, [driver], { timeout: 8_000 });
    return JSON.parse(stdout) as {
      probe: string;
      batchStatus: string;
      snapshotFailed: boolean;
      live: boolean;
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Corrupt only a real native observation receipt at its private pipe boundary. */
async function changedObservationReply(
  mode: "omitted" | "identity-type" | "duplicate" | "unexpected" | "identity-pid" | "version" | "failure",
) {
  const directory = await mkdtemp(join(tmpdir(), "clankie-process-receipt-"));
  try {
    await copyFile(join(import.meta.dirname, "../src/process.ts"), join(directory, "process.ts"));
    await writeFile(
      join(directory, "native.py"),
      `import json, runpy, sys
scope = runpy.run_path(${JSON.stringify(resourceNativeHelperPath())})
reply = scope["observe_processes"]()
mode = ${JSON.stringify(mode)}
rows = reply["observations"]
if mode == "omitted":
    reply["observations"] = rows[1:]
elif mode == "identity-type":
    rows[0]["identity"]["startTime"] = 123
elif mode == "duplicate":
    rows[1] = rows[0]
elif mode == "unexpected":
    rows[0]["pid"] = 2147483647
elif mode == "identity-pid":
    rows[0]["identity"]["pid"] = rows[1]["pid"]
elif mode == "version":
    reply["schemaVersion"] = 2
elif mode == "failure":
    sys.exit(1)
print(json.dumps(reply, separators=(",", ":")))
`,
    );
    const driver = join(directory, "driver.mjs");
    await writeFile(
      driver,
      `import {observeProcesses} from ${JSON.stringify(pathToFileURL(join(directory, "process.ts")).href)};
const observations=await observeProcesses([process.pid,process.ppid]);
console.log(JSON.stringify({self:observations.get(process.pid).status,parent:observations.get(process.ppid).status}));
`,
    );
    const { stdout } = await execute(process.execPath, [driver], { timeout: 8_000 });
    return JSON.parse(stdout) as { self: string; parent: string };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("native process observation uncertainty", () => {
  it("proves real helper availability with a fixture caller PID 1 without authorizing PID 1", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clankie-pid-one-observer-"));
    try {
      const driver = join(directory, "driver.mjs");
      await writeFile(
        driver,
        `import {nativeBoundaryAvailable,processIdentity} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/process.ts")).href)};
import {ResourcePressureSampler} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/pressure.ts")).href)};
Object.defineProperty(process,'pid',{value:1});
const available=await nativeBoundaryAvailable();
const pidOneAuthorized=Boolean(await processIdentity(1));
const pressure=await new ResourcePressureSampler().sample({heavySlots:1,simulatorSlots:1,simulatorIdleMs:600000,maxLoadRatio:16,minAvailableMemoryMb:0});
console.log(JSON.stringify({available,pidOneAuthorized,pressureHealthy:pressure.healthy}));
`,
      );
      const { stdout } = await execute(process.execPath, [driver], { timeout: 8_000 });
      expect(JSON.parse(stdout)).toEqual({ available: true, pidOneAuthorized: false, pressureHealthy: true });
      await expect(
        execute(resourcePython, ["-I", resourceNativeHelperPath(), "available", "--unexpected"]),
      ).rejects.toMatchObject({ code: 1 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["darwin-read", "linux-read", "darwin-owner"] as const)(
    "retains unknown instead of proving exit after a %s fixture failure on a live subprocess",
    async (mode) => {
      expect(await deniedProbe(mode)).toEqual({
        probe: "unknown",
        batchStatus: "unknown",
        snapshotFailed: mode !== "darwin-owner",
        live: true,
      });
    },
  );

  it("leaves a missing PID unknown while retaining an independent exact live receipt", async () => {
    expect(await changedObservationReply("omitted")).toEqual({ self: "unknown", parent: "live" });
  });

  it.each(["identity-type", "duplicate", "unexpected", "identity-pid", "version", "failure"] as const)(
    "refuses exit authority from a %s observation receipt",
    async (mode) => {
      expect(await changedObservationReply(mode)).toEqual({ self: "unknown", parent: "unknown" });
    },
  );

  it("freshly observes only the requested real PIDs, deduplicates them, and proves a child exit", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const exited = once(child, "exit");
    try {
      const ownIdentity = await processIdentity(),
        childIdentity = await processIdentity(child.pid);
      expect(ownIdentity).toBeDefined();
      expect(childIdentity).toBeDefined();
      // A broad census can be unavailable because another process is protected;
      // that does not obstruct fresh exact observations of these owned PIDs.
      const census = await processSnapshot().catch(() => undefined);
      if (census) expect(census).toContainEqual(childIdentity);
      const live = await observeProcesses([process.pid, childIdentity!.pid, process.pid]);
      expect(live.size).toBe(2);
      expect(live.get(process.pid)).toEqual({ status: "live", identity: ownIdentity });
      expect(live.get(childIdentity!.pid)).toEqual({ status: "live", identity: childIdentity });
      child.kill("SIGTERM");
      await exited;
      const terminal = await observeProcesses([process.pid, childIdentity!.pid]);
      expect(terminal.get(childIdentity!.pid)).toEqual({ status: "exited" });
      expect(terminal.get(process.pid)).toEqual({ status: "live", identity: ownIdentity });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });

  it("proves exit after its own real subprocess terminates", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const exited = once(child, "exit");
    try {
      const identity = await processIdentity(child.pid);
      expect(identity).toBeDefined();
      child.kill("SIGTERM");
      await exited;
      expect(await probeProcess(identity!)).toBe("exited");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });

  it("never submits a nested command after cancellation despite a valid inherited permit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clankie-nested-cancelled-"));
    const governor = createResourceGovernor({ directory });
    const receipt = join(directory, "command-submitted"),
      result = join(directory, "result.json"),
      driver = join(directory, "driver.mjs");
    try {
      await governor.configure({
        ...defaultResourcePolicy(),
        heavySlots: 1,
        maxLoadRatio: 10,
        minAvailableMemoryMb: 0,
      });
      await writeFile(
        driver,
        `import {createResourceGovernor} from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../src/governor.ts")).href)};
import {writeFile} from 'node:fs/promises';
const governor=createResourceGovernor({directory:${JSON.stringify(directory)}});
const controller=new AbortController();
controller.abort();
const before=await governor.snapshot();
const code=await governor.runHeavy('/usr/bin/touch',[${JSON.stringify(receipt)}],{signal:controller.signal});
await writeFile(${JSON.stringify(result)},JSON.stringify({code,leaseCount:before.leases.length}));
await governor.close();
`,
      );
      expect(await governor.runHeavy(process.execPath, [driver])).toBe(0);
      expect(JSON.parse(await readFile(result, "utf8"))).toEqual({ code: 130, leaseCount: 1 });
      await expect(access(receipt)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await governor.snapshot()).leases).toHaveLength(0);
    } finally {
      await governor.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
