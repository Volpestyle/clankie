import { describe, expect, it } from "vitest";
import { MissionPlanSchema } from "@clankie/protocol";
import { evaluateLeadRun, reportToMarkdown } from "../src/index.ts";

const plan = MissionPlanSchema.parse({
  missionId: "m1",
  goal: "self build",
  rationale: "prove lead",
  profileHash: "hash",
  successCriteria: ["passes"],
  tasks: [
    {
      id: "implement",
      title: "Implement",
      objective: "implement",
      kind: "implementation",
      role: "implementer",
      successCriteria: ["code"],
      evidenceRequirements: ["A diff is attached."],
    },
    {
      id: "verify",
      title: "Verify",
      objective: "verify",
      kind: "verification",
      role: "verifier",
      dependsOn: ["implement"],
      successCriteria: ["tests"],
      evidenceRequirements: ["The test command and exit code are attached."],
    },
  ],
});

describe("lead eval", () => {
  it("requires critical governance and recovery evidence", () => {
    const report = evaluateLeadRun({
      plan,
      events: [
        {
          id: "1",
          occurredAt: new Date().toISOString(),
          missionId: "m1",
          correlationId: "c",
          profileHash: "hash",
          type: "mission.created",
          data: {},
        },
        {
          id: "2",
          occurredAt: new Date().toISOString(),
          missionId: "m1",
          correlationId: "c",
          profileHash: "hash",
          type: "task.started",
          data: {},
        },
        {
          id: "3",
          occurredAt: new Date().toISOString(),
          missionId: "m1",
          correlationId: "c",
          profileHash: "hash",
          type: "task.failed",
          data: {},
        },
        {
          id: "4",
          occurredAt: new Date().toISOString(),
          missionId: "m1",
          correlationId: "c",
          profileHash: "hash",
          type: "task.added",
          data: {},
        },
        {
          id: "5",
          occurredAt: new Date().toISOString(),
          missionId: "m1",
          correlationId: "c",
          profileHash: "hash",
          type: "task.succeeded",
          data: {},
        },
        {
          id: "6",
          occurredAt: new Date().toISOString(),
          missionId: "m1",
          correlationId: "c",
          profileHash: "hash",
          type: "mission.succeeded",
          data: {},
        },
      ],
      finalMissionState: "succeeded",
      implementationWorkerId: "builder",
      verificationWorkerId: "reviewer",
      firstVerificationFailed: true,
      recoveryTaskAdded: true,
      secondVerificationPassed: true,
      privilegedActionRequested: true,
      privilegedActionDecision: "require_approval",
      approvalRecorded: true,
      privilegedActionExecuted: true,
      evidenceCount: 4,
      unapprovedSideEffects: 0,
    });
    expect(report.passed).toBe(true);
    expect(report.doctrineHash).toBe(plan.profileHash);
    expect(reportToMarkdown(report)).toContain(`**Doctrine hash:** \`${plan.profileHash}\``);
  });
});
