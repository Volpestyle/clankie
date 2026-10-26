import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { runCodexSeat } from "../src/command/codex-seat.ts";

const repoRoot = join(import.meta.dirname, "../../..");

test("Codex confines nonce to private MCP file across actual exec-child inheritance", async () => {
  const root = mkdtempSync(join(tmpdir(), "codex-seat-nonce-"));
  let noncePath: string | undefined;
  const stopped = new Error("fixture stopped before starting native model harness");
  try {
    await expect(
      runCodexSeat(
        { resume: false, dryRun: false, conversationId: "nonce-fixture" },
        {
          repoRoot,
          env: {
            HOME: root,
            XDG_STATE_HOME: root,
            CLANKIE_SETTINGS_FILE: join(root, "settings.json"),
            CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
            CLANKIE_OPERATOR_TOKEN: "clankie_op_" + "a".repeat(43),
            CLANKIE_BRIDGE_NONCE: "contaminated-parent-nonce",
            CLANKIE_BRIDGE_NONCE_FILE: "/contaminated-parent-file",
          },
          execFileImpl: async (_command, args) => ({
            stdout: args.includes("list")
              ? JSON.stringify({ installed: [{ pluginId: "clankie@clankie-seat" }] })
              : "codex fixture",
            stderr: "",
          }),
          fetchImpl: async () => Response.json({ conversationId: "nonce-fixture", cwd: root }),
          stderr: { write() {} },
          trackerOverrides: async () => [],
          startImpl: async (options) => {
            const inherited = JSON.parse(
              execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
                env: options.env,
                encoding: "utf8",
              }),
            );
            expect(inherited.CLANKIE_BRIDGE_NONCE).toBeUndefined();
            expect(inherited.CLANKIE_BRIDGE_NONCE_FILE).toBeUndefined();
            expect(options.config).toContain('plugins."clankie@clankie-seat".mcp_servers.lead.enabled=false');
            const bridge = options.config!.find((value) => value.startsWith("mcp_servers.clankie="))!;
            noncePath = JSON.parse(/CLANKIE_BRIDGE_NONCE_FILE=("[^"]+")/u.exec(bridge)![1]!);
            expect(statSync(noncePath!).mode & 0o777).toBe(0o600);
            const nonce = readFileSync(noncePath!, "utf8");
            expect(nonce).toMatch(/^[a-f0-9]{64}$/u);
            expect(JSON.stringify(options.env)).not.toContain(nonce);
            expect(JSON.stringify(options.config)).not.toContain(nonce);
            throw stopped;
          },
        },
      ),
    ).rejects.toBe(stopped);
    expect(noncePath).toBeDefined();
    expect(() => statSync(noncePath!)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
