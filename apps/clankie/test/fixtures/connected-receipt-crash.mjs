// Real filesystem/process boundary: only the chosen manifest commit is faulted.
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
store.save();
throw new Error("Expected manifest fault was not reached");
