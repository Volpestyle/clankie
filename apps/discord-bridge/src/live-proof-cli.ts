import {
  readDiscordBridgeReceipts,
  resolveDiscordReceiptPath,
  writeCheckReport,
} from "@clankie/discord-presence-core";
import {
  evaluateDiscordLiveProof,
  evaluateDiscordPersonMemoryLiveProof,
  evaluateDiscordVoiceLiveProof,
} from "./live-proof.ts";

const path = resolveDiscordReceiptPath({
  configured: process.env.DISCORD_BRIDGE_RECEIPT_PATH,
  envName: "DISCORD_BRIDGE_RECEIPT_PATH",
  defaultFileName: "discord-live-receipts.jsonl",
});
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

writeCheckReport({
  checks: report.checks,
  json: process.argv.includes("--json"),
  jsonPayload: report,
  title,
  outcome: report.passed ? "PASS" : "INCOMPLETE",
});
if (!report.passed) process.exitCode = 1;
