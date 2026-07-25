import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  FROZEN_REAL_WORKER_FIXTURE_SHA256,
  isCommittedRealWorkerRun,
  realWorkersRepoRoot,
} from "./real-workers.ts";

const ExpectedProviders = new Map([
  ["implement-seeded-retry", "codex"],
  ["verify-seeded-retry", "claude"],
  ["debug-retry", "pi"],
  ["reverify-retry", "claude"],
]);

const ReceiptSchema = z
  .object({
    result: z.literal("PASS"),
    missionId: z.string().min(1),
    fixture: z
      .object({
        aggregateSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .passthrough(),
    nativeSessions: z.array(
      z
        .object({
          taskId: z.string().min(1),
          provider: z.enum(["codex", "claude", "pi"]),
          workerRunId: z.string().min(1),
          nativeSessionId: z.string().min(1),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export interface RealWorkerReceiptEvaluation {
  schemaVersion: 1;
  passed: boolean;
  checks: Array<{ name: string; ok: boolean }>;
  identity?: {
    missionId: string;
    fixtureSha256: string;
  };
}

/** Validates the last atomically committed real-provider proof without launching another mission. */
export async function evaluateRealWorkerReceipt(directory?: string): Promise<RealWorkerReceiptEvaluation> {
  const receiptDirectory = resolve(directory ?? join(realWorkersRepoRoot, "artifacts/evals/real-workers"));
  const committed = await isCommittedRealWorkerRun(receiptDirectory);
  if (!committed) {
    return {
      schemaVersion: 1,
      passed: false,
      checks: [{ name: "committed artifact tree", ok: false }],
    };
  }

  let parsed: z.infer<typeof ReceiptSchema>;
  try {
    parsed = ReceiptSchema.parse(
      JSON.parse(await readFile(join(receiptDirectory, "real-workers-report.json"), "utf8")),
    );
  } catch {
    return {
      schemaVersion: 1,
      passed: false,
      checks: [
        { name: "committed artifact tree", ok: true },
        { name: "strict report schema", ok: false },
      ],
    };
  }

  const sessions = new Map(parsed.nativeSessions.map((session) => [session.taskId, session]));
  const providerLineage =
    sessions.size === ExpectedProviders.size &&
    [...ExpectedProviders].every(([taskId, provider]) => sessions.get(taskId)?.provider === provider);
  const nativeSessionIds = parsed.nativeSessions.map((session) => session.nativeSessionId);
  const workerRunIds = parsed.nativeSessions.map((session) => session.workerRunId);
  const checks = [
    { name: "committed artifact tree", ok: true },
    {
      name: "frozen fixture identity",
      ok: parsed.fixture.aggregateSha256 === FROZEN_REAL_WORKER_FIXTURE_SHA256,
    },
    { name: "four-task provider lineage", ok: providerLineage },
    {
      name: "distinct native sessions",
      ok:
        nativeSessionIds.length === ExpectedProviders.size &&
        new Set(nativeSessionIds).size === nativeSessionIds.length,
    },
    {
      name: "distinct worker runs",
      ok:
        workerRunIds.length === ExpectedProviders.size && new Set(workerRunIds).size === workerRunIds.length,
    },
  ];
  return {
    schemaVersion: 1,
    passed: checks.every((check) => check.ok),
    checks,
    identity: {
      missionId: parsed.missionId,
      fixtureSha256: parsed.fixture.aggregateSha256,
    },
  };
}
