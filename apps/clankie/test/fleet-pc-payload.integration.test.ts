import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { expect, it } from "vitest";
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
