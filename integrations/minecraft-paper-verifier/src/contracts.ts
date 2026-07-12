import {
  EnvironmentSemanticEventSchema,
  type EnvironmentSemanticEvent,
} from "@clankie/interactive-environment";
import { InteractiveEnvironmentBindingSchema } from "@clankie/protocol";
import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const ScenarioBindingSchema = z
  .object({
    schemaVersion: z.literal(1),
    environment: InteractiveEnvironmentBindingSchema,
    scenarioId: z.string().min(1),
    scenarioVersion: z.number().int().positive(),
    fixtureSha256: Sha256Schema,
  })
  .strict();
export type ScenarioBinding = z.infer<typeof ScenarioBindingSchema>;

const ArtifactSchema = z
  .object({ kind: z.enum(["event_log", "report"]), path: z.string().min(1), sha256: Sha256Schema })
  .strict();

export const ScenarioReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    scenarioId: z.string().min(1),
    scenarioVersion: z.number().int().positive(),
    fixtureSha256: Sha256Schema,
    runId: z.string().min(1),
    result: z.enum(["passed", "failed"]),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative(),
    startingStateSha256: Sha256Schema,
    eventChainHeadSha256: Sha256Schema,
    checks: z.record(z.string(), z.boolean()),
    finalState: z
      .object({
        playerName: z.string().min(1),
        alive: z.boolean(),
        health: z.number().nonnegative(),
        gameMode: z.string().min(1),
        collectedLogs: z.number().int().nonnegative(),
        craftedTable: z.boolean(),
        placedTableInTarget: z.boolean(),
        actualPlacedBlock: z.string().min(1),
        inventory: z.record(z.string(), z.number().int().nonnegative()),
        violations: z.array(z.string()),
      })
      .strict(),
    artifacts: z.array(ArtifactSchema).max(8),
  })
  .strict()
  .superRefine((report, context) => {
    const allChecksPass = Object.values(report.checks).every(Boolean);
    if ((report.result === "passed") !== allChecksPass) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "result disagrees with authoritative checks",
      });
    }
  });
export type ScenarioReport = z.infer<typeof ScenarioReportSchema>;

export function verifierGoalEvent(
  reportInput: unknown,
  bindingInput: unknown,
  occurredAt = new Date().toISOString(),
): EnvironmentSemanticEvent {
  const report = ScenarioReportSchema.parse(reportInput);
  const binding = ScenarioBindingSchema.parse(bindingInput);
  if (
    report.scenarioId !== binding.scenarioId ||
    report.scenarioVersion !== binding.scenarioVersion ||
    report.fixtureSha256 !== binding.fixtureSha256
  ) {
    throw new Error("Verifier report does not match the frozen scenario binding");
  }
  const reportArtifact = report.artifacts.find((artifact) => artifact.kind === "report");
  return EnvironmentSemanticEventSchema.parse({
    schemaVersion: 1,
    plane: "semantic",
    id: `paper-verifier:${report.runId}`,
    type: report.result === "passed" ? "minecraft.goal.verified" : "minecraft.goal.failed",
    occurredAt,
    correlationId: report.runId,
    sessionId: binding.environment.environmentSessionId,
    data: {
      scenarioId: report.scenarioId,
      scenarioVersion: report.scenarioVersion,
      fixtureSha256: report.fixtureSha256,
      ...(reportArtifact ? { reportSha256: reportArtifact.sha256 } : {}),
    },
  });
}
