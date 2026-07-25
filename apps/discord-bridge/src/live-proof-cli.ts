import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { evaluateDiscordLiveProof, readDiscordLiveReceipts } from "./live-proof.ts";

const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
if (!isAbsolute(stateHome)) throw new Error("XDG_STATE_HOME must be absolute");
const path =
  process.env.DISCORD_BRIDGE_RECEIPT_PATH ?? join(stateHome, "clankie", "discord-live-receipts.jsonl");
const report = evaluateDiscordLiveProof(await readDiscordLiveReceipts(path));

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const width = Math.max(...report.checks.map((check) => check.name.length));
  for (const check of report.checks) {
    process.stdout.write(`${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(width)}  ${check.detail}\n`);
  }
  process.stdout.write(`\nDiscord text live proof: ${report.passed ? "PASS" : "INCOMPLETE"}\n`);
}
if (!report.passed) process.exitCode = 1;
