import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitRealWorkerRun, FROZEN_REAL_WORKER_FIXTURE_SHA256 } from "../src/real-workers.ts";
import { evaluateRealWorkerReceipt } from "../src/real-workers-receipt.ts";

describe("real-provider committed receipt", () => {
  it("accepts the exact frozen provider lineage and rejects later artifact tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-real-worker-receipt-"));
    const staging = await mkdtemp(join(root, ".staging-"));
    const output = join(root, "committed");
    const reportPath = join(staging, "real-workers-report.json");
    const manifestPath = join(staging, "real-workers-manifest.jsonl");
    try {
      await writeFile(reportPath, `${JSON.stringify(validReport(), null, 2)}\n`);
      await writeFile(manifestPath, '{"sequence":1,"hash":"fixture"}\n');
      await commitRealWorkerRun({
        stagingDirectory: staging,
        outputDirectory: output,
        reportPath,
        manifestPath,
      });

      await expect(evaluateRealWorkerReceipt(output)).resolves.toMatchObject({
        passed: true,
        identity: { missionId: "mission-receipt" },
      });

      await writeFile(join(output, "real-workers-report.json"), "{}\n");
      await expect(evaluateRealWorkerReceipt(output)).resolves.toMatchObject({
        passed: false,
        checks: [{ name: "committed artifact tree", ok: false }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function validReport(): Record<string, unknown> {
  return {
    result: "PASS",
    missionId: "mission-receipt",
    fixture: { aggregateSha256: FROZEN_REAL_WORKER_FIXTURE_SHA256 },
    nativeSessions: [
      session("implement-seeded-retry", "codex", "run-codex", "session-codex"),
      session("verify-seeded-retry", "claude", "run-claude-1", "session-claude-1"),
      session("debug-retry", "pi", "run-pi", "session-pi"),
      session("reverify-retry", "claude", "run-claude-2", "session-claude-2"),
    ],
  };
}

function session(
  taskId: string,
  provider: "codex" | "claude" | "pi",
  workerRunId: string,
  nativeSessionId: string,
): Record<string, string> {
  return { taskId, provider, workerRunId, nativeSessionId };
}
