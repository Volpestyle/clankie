import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readDiscordBridgeReceipts } from "@clankie/discord-presence-core";
import {
  evaluateDiscordLiveProof,
  evaluateDiscordPersonMemoryLiveProof,
  evaluateDiscordVoiceLiveProof,
} from "./live-proof.ts";

const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
if (!isAbsolute(stateHome)) throw new Error("XDG_STATE_HOME must be absolute");
const path =
  process.env.DISCORD_BRIDGE_RECEIPT_PATH ?? join(stateHome, "clankie", "discord-live-receipts.jsonl");
const receipts = await readDiscordBridgeReceipts(path);
const mode = process.argv[2];
const report =
  mode === "person-memory"
    ? evaluateDiscordPersonMemoryLiveProof(receipts)
    : mode === "voice"
      ? evaluateDiscordVoiceLiveProof(receipts)
      : evaluateDiscordLiveProof(receipts);
const title =
  mode === "person-memory"
    ? "Discord person-memory live proof"
    : mode === "voice"
      ? "Discord group voice live proof"
      : "Discord text live proof";

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const width = Math.max(...report.checks.map((check) => check.name.length));
  for (const check of report.checks) {
    process.stdout.write(`${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(width)}  ${check.detail}\n`);
  }
  process.stdout.write(`\n${title}: ${report.passed ? "PASS" : "INCOMPLETE"}\n`);
}
if (!report.passed) process.exitCode = 1;
