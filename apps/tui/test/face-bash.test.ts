/**
 * Vitest port of the v1 inline `!` shell escape smoke: the host command runner
 * (stdout/stderr capture, streaming, exit codes, output cap, timeout,
 * spawn-error, cancel). Spawns only trivial portable shell commands (printf,
 * exit, sleep) with short timeouts so the suite stays deterministic and
 * TTY-free. Rendering belongs to pi's BashExecutionComponent now.
 */
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { runFaceBashCommand } from "../src/face/clankie-face-bash.ts";

const cwd = process.cwd();
const env = process.env;

describe("runFaceBashCommand", () => {
  it("captures stdout, exit 0, and fires onSpawn with a live child", async () => {
    let spawned: ChildProcess | undefined;
    const ok = await runFaceBashCommand("printf 'hello world'", {
      cwd,
      env,
      onSpawn: (child) => {
        spawned = child;
      },
    });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe("hello world");
    expect(ok.stderr).toBe("");
    expect(ok.timedOut).toBe(false);
    expect(ok.truncated).toBe(false);
    expect(spawned).toBeDefined();
    expect(typeof spawned?.kill).toBe("function");
  });

  it("streams captured output through onOutput as it arrives", async () => {
    const chunks: string[] = [];
    const streamed = await runFaceBashCommand("printf 'first'; printf 'boom' 1>&2", {
      cwd,
      env,
      onOutput: (chunk) => {
        chunks.push(chunk);
      },
    });
    expect(chunks.join("")).toContain("first");
    expect(chunks.join("")).toContain("boom");
    expect(streamed.stdout).toBe("first");
    expect(streamed.stderr).toBe("boom");
  });

  it("captures stderr and propagates non-zero exit codes", async () => {
    const fail = await runFaceBashCommand("printf 'boom' 1>&2; exit 3", { cwd, env });
    expect(fail.code).toBe(3);
    expect(fail.stderr).toBe("boom");
    expect(fail.stdout).toBe("");
  });

  it("flags truncation and stops streaming past the output cap", async () => {
    const chunks: string[] = [];
    const big = await runFaceBashCommand("for i in $(seq 1 1000); do printf 'xxxxxxxxxx'; done", {
      cwd,
      env,
      maxOutput: 100,
      onOutput: (chunk) => {
        chunks.push(chunk);
      },
    });
    expect(big.truncated).toBe(true);
    expect(big.stdout.length).toBeLessThanOrEqual(100);
    expect(chunks.join("").length).toBeLessThanOrEqual(100);
  });

  it("kills timed-out commands promptly and flags timedOut", async () => {
    const slow = await runFaceBashCommand("sleep 5", { cwd, env, timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
    expect(slow.durationMs).toBeLessThan(4000);
  });

  it("resolves (never rejects) a bad shell as a non-zero result", async () => {
    const badShell = await runFaceBashCommand("echo hi", { cwd, env, shell: "/nonexistent/shell-xyz" });
    expect(badShell.code).not.toBe(0);
    expect(badShell.stderr.length).toBeGreaterThan(0);
  });

  it("resolves non-zero promptly when cancelled through the onSpawn child", async () => {
    const cancelled = await runFaceBashCommand("sleep 5", {
      cwd,
      env,
      onSpawn: (child) => child.kill("SIGINT"),
    });
    expect(cancelled.code).not.toBe(0);
    expect(cancelled.durationMs).toBeLessThan(4000);
  });
});
