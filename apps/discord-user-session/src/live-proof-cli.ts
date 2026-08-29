import {
  readDiscordBridgeReceipts,
  resolveDiscordReceiptPath,
  writeCheckReport,
} from "@clankie/discord-presence-core";
import { evaluateStreamPublishLiveProof, evaluateStreamWatchLiveProof } from "./live-proof.ts";

const path = resolveDiscordReceiptPath({
  configured: process.env.DISCORD_USER_SESSION_RECEIPT_PATH,
  envName: "DISCORD_USER_SESSION_RECEIPT_PATH",
  defaultFileName: "discord-user-session-receipts.jsonl",
});
const mode = process.argv[2] === "publish" ? "publish" : "watch";
const evaluate = mode === "publish" ? evaluateStreamPublishLiveProof : evaluateStreamWatchLiveProof;

const waitFlag = process.argv.find((arg) => arg.startsWith("--wait"));
const waitMs = waitFlag === undefined ? 0 : Number.parseInt(waitFlag.split("=")[1] ?? "120", 10) * 1_000;
const deadline = Date.now() + (Number.isFinite(waitMs) ? waitMs : 0);

let report = evaluate(await readDiscordBridgeReceipts(path));
while (!report.passed && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  report = evaluate(await readDiscordBridgeReceipts(path));
}

writeCheckReport({
  checks: report.checks,
  json: process.argv.includes("--json"),
  jsonPayload: { path, ...report },
  title: `Discord stream-${mode} live proof`,
  outcome: report.passed ? "PASS" : "INCOMPLETE",
  preamble: `receipts: ${path}`,
  minNameWidth: 8,
  ...(report.passed
    ? {}
    : {
        epilogue:
          mode === "publish"
            ? "Start Go Live in an allowlisted voice channel while the lab body is up, then rerun. Deterministic tests cannot mint these receipts.\n"
            : "Share a screen in an allowlisted voice channel while the lab body is up, then rerun. Deterministic tests cannot mint these receipts.\n",
      }),
});
if (!report.passed) process.exitCode = 1;
