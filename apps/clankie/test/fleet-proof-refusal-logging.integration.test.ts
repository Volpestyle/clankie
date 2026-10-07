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
  expect(records).toHaveLength(4);
  const proofs = records.filter((record) => record.event === "fleet.local_proof.refused");
  const contexts = records.filter((record) => record.event === "fleet.local_proof.refusal_context");
  expect(proofs.map((record) => record.reason)).toEqual(["invalid_pane", "missing_binding"]);
  for (const record of proofs) {
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
  expect(contexts).toHaveLength(2);
  expect(new Set(contexts.map((record) => record.requestId)).size).toBe(2);
  for (const record of contexts) {
    expect(record).toMatchObject({ operation: "fleet", route: "events", method: "GET" });
    expect(record.requestId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(record.connectionId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(record).not.toHaveProperty("claimedBridgeId");
    if (process.platform === "darwin") {
      expect(["kernel_observed", "previous_kernel_observation"]).toContain(record.callerAttribution);
      expect(record.callerPid).toBeGreaterThan(1);
      expect(record.callerPid).not.toBe(314159);
      expect(record.callerBirth).toHaveLength(2);
    } else {
      expect(record.callerAttribution).toBe("unknown");
      expect(record).not.toHaveProperty("callerPid");
    }
  }
  if (process.platform === "darwin") {
    expect(contexts.map((record) => record.callerAttribution)).toEqual([
      "kernel_observed",
      "previous_kernel_observation",
    ]);
    expect(new Set(contexts.map((record) => record.connectionId)).size).toBe(1);
    expect(contexts[0].callerObservedAt).toBe(contexts[1].callerObservedAt);
  }
  expect(contexts.find((record) => record.reason === "invalid_pane")).not.toHaveProperty("claimedPane");
  expect(contexts.find((record) => record.reason === "missing_binding")).toMatchObject({
    claimedPane: "w1:p1",
  });
  expect(stdout).not.toContain("PID_PATH_ARGV_SENTINEL");
  expect(stdout).not.toContain("/private/sensitive");
});
