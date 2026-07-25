import { evaluateDiscordTuiLiveReceipt, readDiscordTuiLiveReceipt } from "./discord-tui-live-proof.ts";

const path = process.env.CLANKIE_DISCORD_TUI_LIVE_RECEIPT_PATH;
if (path === undefined || path.trim().length === 0) {
  throw new Error("CLANKIE_DISCORD_TUI_LIVE_RECEIPT_PATH is required");
}
const report = evaluateDiscordTuiLiveReceipt(await readDiscordTuiLiveReceipt(path));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
