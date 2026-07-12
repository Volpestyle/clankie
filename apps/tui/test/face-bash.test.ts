/**
 * Vitest port of the v1 inline `!` shell escape smoke: the host command runner
 * (stdout/stderr capture, exit codes, output cap, timeout, spawn-error, cancel)
 * and the result renderer (header, output, exit/duration footer, notes).
 * Spawns only trivial portable shell commands (printf, exit, sleep) with short
 * timeouts so the suite stays deterministic and TTY-free.
 */
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  ClankieBashResultComponent,
  formatFaceBashResultLines,
  runFaceBashCommand,
  type FaceBashResult,
} from "../src/face/clankie-face-bash.ts";
import { createClankieFaceAnsiTheme } from "../src/face/clankie-face-theme.ts";

const ansi = createClankieFaceAnsiTheme({ color: false, trueColor: false });
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

  it("captures stderr and propagates non-zero exit codes", async () => {
    const fail = await runFaceBashCommand("printf 'boom' 1>&2; exit 3", { cwd, env });
    expect(fail.code).toBe(3);
    expect(fail.stderr).toBe("boom");
    expect(fail.stdout).toBe("");
  });

  it("flags truncation and stops growing past the output cap", async () => {
    const big = await runFaceBashCommand("for i in $(seq 1 1000); do printf 'xxxxxxxxxx'; done", {
      cwd,
      env,
      maxOutput: 100,
    });
    expect(big.truncated).toBe(true);
    expect(big.stdout.length).toBeLessThanOrEqual(100);
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

describe("formatFaceBashResultLines", () => {
  it("renders the header, stdout body, and a green exit-0 footer", () => {
    const okLines = formatFaceBashResultLines(
      "ls -a",
      { stdout: "a\nb", stderr: "", code: 0, timedOut: false, truncated: false, durationMs: 12 },
      ansi,
      80,
    );
    expect((okLines[0] ?? "").includes("$ ls -a")).toBe(true);
    expect(okLines.some((line) => line.includes("a"))).toBe(true);
    expect(okLines.some((line) => line.includes("b"))).toBe(true);
    expect(okLines.some((line) => line.includes("exit 0"))).toBe(true);
    expect(
      okLines.some((line) => line.includes("12ms")),
      "sub-second duration renders in ms",
    ).toBe(true);
  });

  it("renders empty output, non-zero exit, and timed-out/truncated notes", () => {
    const noteResult: FaceBashResult = {
      stdout: "",
      stderr: "",
      code: 124,
      timedOut: true,
      truncated: true,
      durationMs: 2500,
    };
    const noteLines = formatFaceBashResultLines("sleep 5", noteResult, ansi, 80);
    expect(noteLines.some((line) => line.includes("(no output)"))).toBe(true);
    expect(noteLines.some((line) => line.includes("exit 124"))).toBe(true);
    expect(noteLines.some((line) => line.includes("timed out"))).toBe(true);
    expect(noteLines.some((line) => line.includes("output truncated"))).toBe(true);
    expect(
      noteLines.some((line) => line.includes("2.5s")),
      "multi-second duration renders in seconds",
    ).toBe(true);
  });
});

describe("ClankieBashResultComponent", () => {
  it("delegates to the same renderer", () => {
    const component = new ClankieBashResultComponent(
      "pwd",
      { stdout: cwd, stderr: "", code: 0, timedOut: false, truncated: false, durationMs: 5 },
      ansi,
    );
    const componentLines = component.render(80);
    expect((componentLines[0] ?? "").includes("$ pwd")).toBe(true);
    expect(componentLines.some((line) => line.includes(cwd))).toBe(true);
  });
});
