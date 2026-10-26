import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { createLeadSeatRelaunch } from "../src/captain/lead-seat-relaunch.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { paneInputLine } from "../src/captain/pane-draft.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const exec = promisify(execFile);

// Real isolated Herdr shell, native process inventory, SIGTERM, launcher plan,
// scratch Claude config and durable receipt. The vendor executable is a fixture:
// no sign-in, model call, updater, native session resume or GUI prompt can run.
it.skipIf(process.platform !== "darwin")(
  "relaunches a scratch lead through Herdr and refuses session-only home trust",
  async () => {
    const herdr = await isolatedHerdr(join(process.env.HOME!, "restart-proof-logs"));
    try {
      expect(herdr.restoredWorkspaceCount).toBe(0);
      vi.stubEnv("HOME", herdr.env.HOME!);
      vi.stubEnv("CLAUDE_CONFIG_DIR", herdr.env.CLAUDE_CONFIG_DIR!);
      const directory = join(herdr.root, "project");
      const bin = join(herdr.root, "bin");
      const current = join(herdr.root, "current.json");
      const starts = join(herdr.root, "starts.jsonl");
      await mkdir(directory);
      await mkdir(bin);
      await mkdir(herdr.env.CLAUDE_CONFIG_DIR!, { recursive: true });
      const configPath = join(herdr.env.CLAUDE_CONFIG_DIR!, ".claude.json");
      const config = JSON.stringify({
        projects: {
          [directory]: { hasTrustDialogAccepted: true },
          [homedir()]: { hasTrustDialogAccepted: false },
        },
      });
      await writeFile(configPath, config);
      // Executed in the real pane, with the real production planSeat settings.
      const seatModule = fileURLToPath(new URL("../../tui/src/command/seat.ts", import.meta.url));
      const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
      await writeFile(
        join(bin, "clankie"),
        `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { planSeat, parseSeatArgs } from ${JSON.stringify(seatModule)};
const plan = await planSeat(parseSeatArgs(process.argv.slice(3), 'claude'), {
  repoRoot: ${JSON.stringify(repoRoot)}, harnessCommand: 'claude',
  execFileImpl: async () => ({ stdout: '2.1.310', stderr: '' }),
  joinedSeat: { sessionId: randomUUID(), maximumTrust: async () => ({ enabled: false }),
    resolveContext: async () => ({ conversationId: 'global-default', cwd: ${JSON.stringify(directory)} }) },
});
const child = spawn(${JSON.stringify(join(bin, "claude"))}, [...plan.args], { cwd: plan.cwd, stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 0));
`,
        { mode: 0o700 },
      );
      await writeFile(
        join(bin, "claude"),
        `#!/usr/bin/env node
import { writeFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
const value = { sessionId: args[args.indexOf('--session-id') + 1], pid: process.pid,
  settings: JSON.parse(args[args.indexOf('--settings') + 1]), args,
  cwd: process.cwd(), home: process.env.HOME, config: process.env.CLAUDE_CONFIG_DIR };
appendFileSync(${JSON.stringify(starts)}, JSON.stringify(value) + '\\n');
writeFileSync(${JSON.stringify(current)}, JSON.stringify(value));
process.stdout.write('\\x1b[90m──────── Clankie ─\\x1b[0m\\r\\n❯ \\r\\n\\x1b[90m──────────────────\\x1b[0m\\r\\n');
setInterval(() => {}, 1000);
`,
        { mode: 0o700 },
      );
      const runner = createHerdrWatchRunner(
        () => true,
        async (args) => (await exec("herdr", [...args], { env: herdr.env, timeout: 5_000 })).stdout,
      );
      await runner.runInPane!(herdr.pane, [
        join(bin, "clankie"),
        "claude",
        "--conversation",
        "global-default",
      ]);
      const readCurrent = async () => JSON.parse(await readFile(current, "utf8"));
      try {
        await expect
          .poll(readCurrent, { timeout: 10_000 })
          .toMatchObject({ settings: { autoCompactWindow: 300_000 } });
      } catch (error) {
        throw new Error(
          `Scratch launcher did not start: ${await runner.readPane!(herdr.pane, "visible", "ansi")}`,
          { cause: error },
        );
      }
      const previous = await readCurrent();
      await expect
        .poll(async () => paneInputLine("claude", await runner.readPane!(herdr.pane, "visible", "ansi")), {
          timeout: 5_000,
        })
        .toMatchObject({ state: "empty" });
      let launchDirectory = directory;
      const delivered: Array<{ text: string; binding: string }> = [];
      const notices: string[] = [];
      const journalPath = join(herdr.root, "lead-seat-relaunches.json");
      const relaunch = createLeadSeatRelaunch({
        journalPath,
        seat: async () => {
          const state = await readCurrent();
          return {
            paneId: herdr.pane,
            terminalId: "scratch-terminal",
            harness: "claude",
            sessionId: state.sessionId,
            binding: `claude:${state.sessionId}`,
            workingDirectory: launchDirectory,
          };
        },
        paneShell: runner.paneShell!,
        readPane: (pane) => runner.readPane!(pane, "visible", "ansi"),
        runInPane: runner.runInPane!,
        idle: () => true,
        lastOwnerMessageAt: () => undefined,
        deliverBrief: async (_id, text, binding) => {
          delivered.push({ text, binding });
          return true;
        },
        notice: (_id, text) => notices.push(text),
      });
      const input = {
        conversationId: "global-default",
        harness: "claude" as const,
        reason: "fresh_restart" as const,
        guards: { requireIdle: true, requireNoDraft: true, quietOwnerMs: 0 },
        handoffBrief: "Scratch work: verify fresh restart; no owner decision pending.",
      };
      const result = await relaunch.relaunchLeadSeat(input);
      expect(result).toMatchObject({ outcome: "relaunched" });
      const next = await readCurrent();
      expect(next.sessionId).not.toBe(previous.sessionId);
      expect(next.args).not.toContain("--resume");
      expect(next.settings.autoCompactWindow).toBe(300_000);
      expect(next.home).toBe(herdr.env.HOME);
      expect(next.config).toBe(herdr.env.CLAUDE_CONFIG_DIR);
      expect(delivered).toEqual([{ text: input.handoffBrief, binding: `claude:${next.sessionId}` }]);
      expect(notices).toHaveLength(1);
      // Prove refusal before a signal/launch with the actual successor still alive.
      launchDirectory = homedir();
      const refused = await relaunch.relaunchLeadSeat(input);
      expect(refused).toMatchObject({
        outcome: "refused",
        reason: "trust_required",
        detail: expect.stringContaining("clankie workdir set PATH"),
      });
      expect(() => process.kill(next.pid, 0)).not.toThrow();
      expect((await readFile(starts, "utf8")).trim().split("\n")).toHaveLength(2);
      expect(await readFile(configPath, "utf8")).toBe(config);
      if (process.env.RESTART_PROOF_OUTPUT)
        await writeFile(
          process.env.RESTART_PROOF_OUTPUT,
          JSON.stringify(
            {
              restoredWorkspaceCount: herdr.restoredWorkspaceCount,
              scratchRoot: herdr.root,
              result,
              previous,
              next,
              delivered,
              notices,
              refused,
              journal: JSON.parse(await readFile(journalPath, "utf8")),
              configUnchanged: true,
            },
            null,
            2,
          ),
        );
    } finally {
      vi.unstubAllEnvs();
      await herdr.close();
    }
  },
  30_000,
);
