import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readDiscordBridgeReceipts } from "@clankie/discord-presence-core";
import { evaluateStreamPublishLiveProof, evaluateStreamWatchLiveProof } from "./live-proof.ts";

const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
if (!isAbsolute(stateHome)) throw new Error("XDG_STATE_HOME must be absolute");
const path =
  process.env.DISCORD_USER_SESSION_RECEIPT_PATH ??
  join(stateHome, "clankie", "discord-user-session-receipts.jsonl");
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

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ path, ...report }, null, 2)}\n`);
} else {
  process.stdout.write(`receipts: ${path}\n`);
  const width = Math.max(...report.checks.map((check) => check.name.length), 8);
  for (const check of report.checks) {
    process.stdout.write(`${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(width)}  ${check.detail}\n`);
  }
  process.stdout.write(`\nDiscord stream-${mode} live proof: ${report.passed ? "PASS" : "INCOMPLETE"}\n`);
  if (!report.passed) {
    process.stdout.write(
      mode === "publish"
        ? "Start Go Live in an allowlisted voice channel while the lab body is up, then rerun. Deterministic tests cannot mint these receipts.\n"
        : "Share a screen in an allowlisted voice channel while the lab body is up, then rerun. Deterministic tests cannot mint these receipts.\n",
    );
  }
}
if (!report.passed) process.exitCode = 1;
