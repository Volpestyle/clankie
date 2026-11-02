// Real filesystem/process boundary: only the chosen commit point is faulted.
// Modes: unchanged; before/after fault the checkpoint's manifest rename;
// append-before fails the log write, append-torn writes half a line and dies,
// append-after dies once the appended line is fsynced.
import fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const { z } = require("zod");
const [path, mode, id] = process.argv.slice(2);
const rename = fs.renameSync;
fs.renameSync = function (source, target) {
  if (String(target) === path && mode === "before") throw new Error("fixture manifest commit failure");
  const result = rename.call(this, source, target);
  if (String(target) === path && mode === "after") process.kill(process.pid, "SIGKILL");
  return result;
};
const logs = new Set();
const open = fs.openSync;
fs.openSync = function (target, flags, ...rest) {
  const descriptor = open.call(this, target, flags, ...rest);
  if (String(target).endsWith(".jsonl") && flags === "a") logs.add(descriptor);
  return descriptor;
};
const write = fs.writeSync;
fs.writeSync = function (descriptor, data, ...rest) {
  if (logs.has(descriptor) && mode === "append-before") throw new Error("fixture log append failure");
  if (logs.has(descriptor) && mode === "append-torn") {
    write.call(this, descriptor, String(data).slice(0, Math.floor(String(data).length / 2)));
    process.kill(process.pid, "SIGKILL");
  }
  return write.call(this, descriptor, data, ...rest);
};
const fsync = fs.fsyncSync;
fs.fsyncSync = function (descriptor) {
  const result = fsync.call(this, descriptor);
  if (logs.has(descriptor) && mode === "append-after") process.kill(process.pid, "SIGKILL");
  return result;
};
syncBuiltinESMExports();
const { DurableReceiptStore } = await import("../../src/durable-receipt-store.ts");
const store = new DurableReceiptStore({
  path,
  sharded: true,
  schema: z.looseObject({ id: z.string(), createdAt: z.number(), state: z.enum(["uncertain", "settled"]) }),
  unreadableMessage: "Fixture receipts unreadable",
});
const records = store.load();
if (mode === "unchanged") {
  store.save();
  process.exit(0);
}
const original = records.values().next().value;
records.set(id, { ...original, id, state: "uncertain", result: undefined });
// The checkpoint modes fault the manifest commit that a checkpoint makes.
if (mode === "before" || mode === "after") store.saveShards();
else store.save();
throw new Error("Expected fault was not reached");
