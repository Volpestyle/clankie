import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { expect, it } from "vitest";
import { remoteCodexQueue } from "../src/captain/remote-codex-app-server.ts";
import {
  createFleetShellRun,
  powershellScriptCommand,
  remoteProgramCommand,
  type HerdrFleet,
} from "../src/herdr-fleet.ts";

// Explicit opt-in: read-only programs on the real PC, never a worker/pane send.
it.skipIf(!process.env.FLEET_PAYLOAD_PC_HOST)(
  "streams 32 KB Unicode payloads over a real PC multiplexed SSH channel",
  async () => {
    const root = await mkdtemp("/tmp/cp-");
    const host = process.env.FLEET_PAYLOAD_PC_HOST!;
    const pc: HerdrFleet = { id: "payload-proof", session: "default", ssh: { host, shell: "powershell" } };
    const calls: string[][] = [];
    const run: typeof execFile = ((file: string, args: string[], options: object, callback: Function) => {
      calls.push(args);
      return execFile(file, args, options, callback as never);
    }) as typeof execFile;
    const shell = createFleetShellRun(pc, { controlDirectory: root, execFile: run });
    try {
      // First call establishes the mux master; the next command must use it.
      expect((await shell(powershellScriptCommand("Write-Output 'ready'"))).trim()).toBe("ready");
      const text = 'VUH-2135 — ✳ "quotes" & % $HOME \\ paths\n'.repeat(1_024).slice(0, 32_768);
      const bytes = Buffer.from(text, "utf8");
      const payload = bytes.toString("base64");
      const command = powershellScriptCommand(
        `$bytes = [Convert]::FromBase64String('${payload}'); $hash = [Security.Cryptography.SHA256]::Create(); [Console]::WriteLine(([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-','').ToLowerInvariant())`,
      );
      for (let attempt = 0; attempt < 3; attempt += 1)
        expect((await shell(command, 30_000)).trim()).toBe(createHash("sha256").update(bytes).digest("hex"));
      const brief = text.slice(0, 20_000);
      const program =
        "process.stdout.write(require('node:crypto').createHash('sha256').update(process.argv[1]).digest('hex'))";
      expect(
        (await shell(remoteProgramCommand("powershell", "node", ["-e", program, brief]), 30_000)).trim(),
      ).toBe(createHash("sha256").update(brief).digest("hex"));
      // Windows' outer login shell maps a native 127 to 1. The unique
      // bootstrap marker still proves Process.Start failed before any child.
      await expect(
        shell(
          remoteProgramCommand(
            "powershell",
            "node",
            ["-e", "process.exit(0)"],
            `C:\\clankie-proof-absent-${randomUUID()}`,
          ),
        ),
      ).rejects.toMatchObject({ definitive: "not_sent" });
      expect(calls.slice(1).every((args) => Buffer.byteLength(args.at(-1)!) < 4_096)).toBe(true);
      expect(new Set(calls.map((args) => args.find((arg) => arg.startsWith("ControlPath=")))).size).toBe(1);
    } finally {
      // Close only this proof's own SSH master; preserve every fleet connection.
      const control = calls[0]?.find((arg) => arg.startsWith("ControlPath="));
      if (control)
        await new Promise<void>((resolve) =>
          execFile("ssh", ["-o", control, "-O", "exit", "--", host], () => resolve()),
        );
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);

// VUH-2258 opt-in: the argv-bound `codex queue` path on the real PC. The thread
// is a fresh UUID, so no Codex session receives anything; the staged file is removed.
it.skipIf(!process.env.FLEET_PAYLOAD_PC_HOST)(
  "stages a 32 KB codex queue message on the real PC instead of exceeding its command line",
  async () => {
    const root = await mkdtemp("/tmp/cq-");
    const host = process.env.FLEET_PAYLOAD_PC_HOST!;
    const pc: HerdrFleet = { id: "payload-proof", session: "default", ssh: { host, shell: "powershell" } };
    const calls: string[][] = [];
    const run: typeof execFile = ((file: string, args: string[], options: object, callback: Function) => {
      calls.push(args);
      return execFile(file, args, options, callback as never);
    }) as typeof execFile;
    const shell = createFleetShellRun(pc, { controlDirectory: root, execFile: run });
    const commands: { command: string; stdout?: string; error?: string }[] = [];
    const recorded = async (command: string, timeoutMs?: number) => {
      const entry: { command: string; stdout?: string; error?: string } = { command };
      commands.push(entry);
      try {
        entry.stdout = await shell(command, timeoutMs);
        return entry.stdout;
      } catch (error) {
        entry.error = String(error);
        throw error;
      }
    };
    const text = 'VUH-2258 — ✳ "quotes" & % $HOME \\ paths\n'.repeat(1_024).slice(0, 32_768);
    const sha256 = createHash("sha256").update(text).digest("hex");
    try {
      const thread = randomUUID();
      // Baseline: the same message as a raw argument cannot start on Windows.
      const js = (
        await shell(
          powershellScriptCommand(
            "Write-Output ((& npm root -g | Select-Object -First 1) + '\\@openai\\codex\\bin\\codex.js')",
          ),
        )
      ).trim();
      await expect(
        shell(
          remoteProgramCommand("powershell", "node", [js, "queue", "--thread", thread, "--message", text]),
          30_000,
        ),
      ).rejects.toMatchObject({ definitive: "not_sent" });
      // Through the queue: staged, verified, and a short pointer reaches codex.
      const outcome = await remoteCodexQueue(pc, recorded)(thread, text).catch((error: unknown) =>
        String(error),
      );
      const record = {
        thread,
        sha256,
        outcome,
        commands: commands.map(({ stdout, error }) => ({
          stdout: stdout?.slice(0, 300),
          error: error?.slice(0, 600),
        })),
      };
      if (process.env.FLEET_PAYLOAD_EVIDENCE)
        appendFileSync(process.env.FLEET_PAYLOAD_EVIDENCE, JSON.stringify(record) + "\n");
      const staged = commands.find((entry) => entry.stdout?.includes("seat-messages"));
      expect(staged?.stdout?.trim().split("|")[1]).toBe(sha256);
      const path = staged!.stdout!.trim().split("|")[0]!;
      const queued = commands.at(-1)!;
      expect(queued.command).not.toBe(staged!.command);
      // A fresh thread has no session: codex itself answers, never Process.Start.
      expect(String(queued.error ?? queued.stdout ?? outcome)).not.toMatch(/too long|not_sent/iu);
      const readBack = await shell(
        powershellScriptCommand(
          `$b = [IO.File]::ReadAllBytes(${JSON.stringify(path).replaceAll('"', "'")}); [Console]::WriteLine([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($b)).Replace('-','').ToLowerInvariant()); Remove-Item -LiteralPath ${JSON.stringify(path).replaceAll('"', "'")}`,
        ),
      );
      expect(readBack.trim()).toBe(sha256);
    } finally {
      // Close only this proof's own SSH master; preserve every fleet connection.
      const control = calls[0]?.find((arg) => arg.startsWith("ControlPath="));
      if (control)
        await new Promise<void>((resolve) =>
          execFile("ssh", ["-o", control, "-O", "exit", "--", host], () => resolve()),
        );
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
