import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("releases terminal payloads while preserving full early completion and idle-reconciliation delivery", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--expose-gc",
      "--import",
      fileURLToPath(new URL("../../../scripts/dependency-types.mjs", import.meta.url)),
      fileURLToPath(new URL("./fixtures/codex-terminal-retention.mjs", import.meta.url)),
    ],
    { timeout: 60_000 },
  );
  const result = JSON.parse(stdout);
  expect(result).toMatchObject({ ordinaryAlive: 0, reconciledAlive: 0, rejectedAlive: 0, startRequests: 5 });
  expect(result.races).toEqual(
    ["completed", "failed", "interrupted"].map((status) => ({
      status,
      deliveries: 2,
      pendingAlive: 1,
      settledAlive: 0,
    })),
  );
}, 65_000);
