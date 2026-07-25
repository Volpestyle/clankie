import { evaluateRealWorkerReceipt } from "./real-workers-receipt.ts";

const result = await evaluateRealWorkerReceipt(process.env.CLANKIE_REAL_WORKERS_RECEIPT_DIRECTORY);
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
