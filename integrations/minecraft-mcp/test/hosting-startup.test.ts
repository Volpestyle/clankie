import { ChildProcess, type spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MinecraftHost } from "../src/hosting.ts";
const temporary: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
async function startingHost(startupTimeoutMs?: number) {
  const dataDir = await mkdtemp(join(tmpdir(), "minecraft-startup-deadline-"));
  temporary.push(dataDir);
  const child = new ChildProcess();
  Object.assign(child, {
    pid: 12345,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  child.stdin!.on("data", () => child.emit("exit", 0, null));
  const spawnChild = vi.fn().mockReturnValue(child);
  const host = new MinecraftHost({
    dataDir,
    spawn: spawnChild as unknown as typeof spawn,
    ...(startupTimeoutMs === undefined ? {} : { startupTimeoutMs }),
  });
  vi.spyOn(host, "prepare").mockResolvedValue(undefined);
  vi.spyOn(host, "classify").mockResolvedValue("offline");
  vi.spyOn(host as unknown as { java(): Promise<string> }, "java").mockResolvedValue("/test/java");
  vi.useFakeTimers();
  const outcome = host.start().then(
    () => "started",
    () => "failed",
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(spawnChild).toHaveBeenCalledOnce();
  return { host, outcome, dataDir, child };
}
it.each([120000, 480000])(
  "stops a silent Paper process at the bounded %i ms deadline and persists its safe reason",
  async (timeout) => {
    const { host, outcome, dataDir } = await startingHost(timeout === 120000 ? undefined : timeout);
    await vi.advanceTimersByTimeAsync(119999);
    expect(host.status().phase).toBe("starting");
    if (timeout === 480000) {
      await vi.advanceTimersByTimeAsync(1);
      expect(host.status().phase).toBe("starting");
      await vi.advanceTimersByTimeAsync(359999);
      expect(host.status().phase).toBe("starting");
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe("failed");
    expect(host.status()).toMatchObject({ phase: "failed", authReady: false, failure: "startup_timeout" });
    expect(JSON.parse(await readFile(join(dataDir, "last-startup-failure.json"), "utf8"))).toEqual({
      failure: "startup_timeout",
      at: expect.any(Number),
      startupTimeoutMs: timeout,
    });
  },
);
it("distinguishes process exit from a readiness timeout without persisting server output", async () => {
  const { host, outcome, child, dataDir } = await startingHost(480000);
  child.stdout!.emit("data", Buffer.from("untrusted sensitive server output\n"));
  child.emit("exit", 1, null);
  expect(await outcome).toBe("failed");
  expect(host.status().failure).toBe("startup_process_exited");
  const diagnostic = await readFile(join(dataDir, "last-startup-failure.json"), "utf8");
  expect(diagnostic).not.toContain("sensitive");
});
it("rejects startup allowances beyond the AWS eight-minute bound", () => {
  expect(() => new MinecraftHost({ startupTimeoutMs: 480001 })).toThrow();
});
