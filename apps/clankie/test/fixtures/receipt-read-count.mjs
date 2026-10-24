// Count actual filesystem reads through the public receipt API; no I/O is stubbed.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const path = process.argv[2];
let reads = 0;
const readFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  if (String(file) === path) reads++;
  return readFileSync.call(this, file, ...args);
};
syncBuiltinESMExports();
const { SeatCallReceipts } = await import("../../src/seat-call-receipts.ts");
const records = JSON.parse(readFileSync(path, "utf8"));
const original = records[0];
const receipts = new SeatCallReceipts(path);
const results = [];
for (let index = 0; index < 10; index++)
  results.push(receipts.read(original.id, original.tool, original.lane, original.conversationId));
console.log(JSON.stringify({ reads, results }));
