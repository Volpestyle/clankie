import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("logs real socket refusals through the body pino stdout with fixed fields", async () => {
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL("./helpers/project-native-proof/refusal-logging.mjs", import.meta.url))],
    { timeout: 5000, maxBuffer: 65536 },
  );
  expect(stderr).toBe("");
  const records = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records).toHaveLength(2);
  expect(records.map((record) => record.reason)).toEqual(["invalid_pane", "missing_binding"]);
  for (const record of records) {
    expect(record.event).toBe("fleet.local_proof.refused");
    expect(Object.keys(record).sort()).toEqual([
      "event",
      "level",
      "msg",
      "operation",
      "reason",
      "service",
      "source",
      "time",
    ]);
  }
  expect(stdout).not.toContain("PID_PATH_ARGV_SENTINEL");
  expect(stdout).not.toContain("/private/sensitive");
});
