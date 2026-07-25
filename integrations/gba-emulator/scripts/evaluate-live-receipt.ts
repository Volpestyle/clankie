import { evaluateFireRedLiveReceipt } from "../src/live-proof.ts";

const path = process.env.CLANKIE_GBA_LIVE_RECEIPT_PATH;
if (path === undefined || path.trim().length === 0) {
  throw new Error("CLANKIE_GBA_LIVE_RECEIPT_PATH is required");
}
const report = await evaluateFireRedLiveReceipt(path);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
