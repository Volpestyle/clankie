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
import { probeProcess, processIdentity, resourceNativeHelperPath, resourcePython } from "../src/process.ts";

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
      `import {probeProcess,processSnapshot} from ${JSON.stringify(pathToFileURL(join(directory, "process.ts")).href)};
process.kill(process.pid,0);
const probe=await probeProcess({pid:process.pid,startTime:"recorded-incarnation"});
let snapshotFailed=false;
try {await processSnapshot()} catch {snapshotFailed=true}
process.kill(process.pid,0);
console.log(JSON.stringify({probe,snapshotFailed,live:true}));
`,
    );
    const { stdout } = await execute(process.execPath, [driver], { timeout: 8_000 });
    return JSON.parse(stdout) as { probe: string; snapshotFailed: boolean; live: boolean };
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
        snapshotFailed: mode !== "darwin-owner",
        live: true,
      });
    },
  );

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
