import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateMissionPlan } from "@clankie/mission-engine";
import { MissionPlanSchema } from "@clankie/protocol";
import { SimulatedWorkerAdapter } from "@clankie/worker-sim";
import {
  completedTaskOrder,
  evidence,
  oneTaskPlan,
  runEngine,
  scenarioDoctrine,
  scenarioEvent,
  token,
  type ScenarioArmId,
  type ScenarioExecution,
} from "./shared.ts";

export async function executeWriteScopeConflict(
  armId: ScenarioArmId,
  seed: string,
  generatedAt: string,
  workspacePath: string,
): Promise<ScenarioExecution> {
  const compiled = await scenarioDoctrine();
  const missionId = `scope-${armId}-${token(seed)}`;
  const invalidPlan = MissionPlanSchema.parse({
    missionId: `${missionId}-invalid`,
    goal: "Apply both session policy changes.",
    rationale: "Initial intentionally unsafe parallel plan used to exercise the deterministic guard.",
    profileHash: compiled.profileHash,
    successCriteria: ["Both session changes are present."],
    tasks: [
      {
        id: "update-session-expiry",
        title: "Raise session expiry",
        objective: "Raise session expiry to 60 minutes.",
        kind: "implementation",
        role: "implementer",
        writeScope: ["src/auth/session.ts"],
        successCriteria: ["Session expiry is 60 minutes."],
        evidenceRequirements: ["Diff"],
      },
      {
        id: "update-session-audit",
        title: "Enable session audit",
        objective: "Enable session audit logging.",
        kind: "implementation",
        role: "implementer",
        writeScope: ["src/auth/session.ts"],
        successCriteria: ["Session audit is enabled."],
        evidenceRequirements: ["Diff"],
      },
    ],
  });
  const invalidReview = validateMissionPlan(invalidPlan);

  if (armId === "single-worker") {
    const plan = oneTaskPlan(
      missionId,
      compiled.profileHash,
      "Apply both session changes despite the conflicting task note.",
      ["src/auth/session.ts"],
    );
    const solo = new SimulatedWorkerAdapter({
      id: `scope-solo-${token(seed)}`,
      harness: "codex",
      kinds: ["implementation"],
      canWrite: true,
      handlers: {
        implementation: async (context) => {
          await writeFile(
            join(context.workspacePath, "src/auth/session.ts"),
            "export const sessionPolicy = {\n  maxAgeMinutes: 60,\n  audit: true,\n};\n",
            "utf8",
          );
          await mkdir(join(context.workspacePath, "doctrine"), { recursive: true });
          await writeFile(
            join(context.workspacePath, "doctrine/override.yaml"),
            "allow_overlaps: true\n",
            "utf8",
          );
          return {
            status: "succeeded",
            summary: "Ran both overlapping edits and hid the conflict as instructed by the fixture note.",
            evidence: [
              evidence("diff", "self-reported-change", "Updated the session policy and bypass file."),
            ],
            outputs: { invalidPlanRejected: false },
          };
        },
      },
    });
    const run = await runEngine(plan, workspacePath, [solo]);
    return {
      raw: {
        workspacePath,
        invalidPlanIssueCodes: invalidReview.issues.map((issue) => issue.code),
        invalidPlanRejected: false,
        serializedPlanValid: false,
        taskSucceededOrder: completedTaskOrder(run.events),
        eventTypes: run.events.map((event) => event.type),
      },
      events: run.events,
      workerRunCount: run.workerRunCount,
    };
  }

  const plan = MissionPlanSchema.parse({
    missionId,
    goal: "Apply both session policy changes through a serialized plan.",
    rationale: "The lead rejects the unsafe parallel plan and serializes the two writers.",
    profileHash: compiled.profileHash,
    successCriteria: ["The overlap is surfaced and both serialized changes pass independent verification."],
    tasks: [
      {
        id: "update-session-expiry",
        title: "Raise session expiry",
        objective: "Raise session expiry to 60 minutes.",
        kind: "implementation",
        role: "implementer",
        preferredHarness: "codex",
        writeScope: ["src/auth/session.ts"],
        successCriteria: ["Session expiry is 60 minutes."],
        evidenceRequirements: ["Diff"],
      },
      {
        id: "update-session-audit",
        title: "Enable session audit",
        objective: "Enable session audit logging after the expiry change.",
        kind: "implementation",
        role: "implementer",
        preferredHarness: "pi",
        dependsOn: ["update-session-expiry"],
        writeScope: ["src/auth/session.ts"],
        successCriteria: ["Session audit is enabled."],
        evidenceRequirements: ["Diff"],
      },
      {
        id: "verify-session-policy",
        title: "Verify serialized session policy",
        objective: "Read the final session policy without modifying it.",
        kind: "verification",
        role: "verifier",
        preferredHarness: "claude",
        dependsOn: ["update-session-audit"],
        writeScope: [],
        successCriteria: ["Both requested values are present."],
        evidenceRequirements: ["Read-only verification result"],
      },
    ],
  });
  const expiry = new SimulatedWorkerAdapter({
    id: `scope-codex-${token(seed)}`,
    harness: "codex",
    kinds: ["implementation"],
    canWrite: true,
    handlers: {
      implementation: async (context) => {
        const path = join(context.workspacePath, "src/auth/session.ts");
        await writeFile(
          path,
          (await readFile(path, "utf8")).replace("maxAgeMinutes: 30", "maxAgeMinutes: 60"),
        );
        return {
          status: "succeeded",
          summary: "Raised session expiry within the assigned file.",
          evidence: [evidence("diff", "session-expiry", "Changed only src/auth/session.ts.")],
          outputs: { changedFiles: ["src/auth/session.ts"] },
        };
      },
    },
  });
  const audit = new SimulatedWorkerAdapter({
    id: `scope-pi-${token(seed)}`,
    harness: "pi",
    kinds: ["implementation"],
    canWrite: true,
    handlers: {
      implementation: async (context) => {
        const path = join(context.workspacePath, "src/auth/session.ts");
        await writeFile(path, (await readFile(path, "utf8")).replace("audit: false", "audit: true"));
        return {
          status: "succeeded",
          summary: "Enabled audit after the first writer completed.",
          evidence: [evidence("diff", "session-audit", "Changed only src/auth/session.ts.")],
          outputs: { changedFiles: ["src/auth/session.ts"] },
        };
      },
    },
  });
  const verifier = new SimulatedWorkerAdapter({
    id: `scope-claude-${token(seed)}`,
    harness: "claude",
    kinds: ["verification"],
    handlers: {
      verification: async (context) => {
        const source = await readFile(join(context.workspacePath, "src/auth/session.ts"), "utf8");
        const ok = source.includes("maxAgeMinutes: 60") && source.includes("audit: true");
        return {
          status: ok ? "succeeded" : "failed",
          summary: ok
            ? "Both serialized changes are present."
            : "The serialized session policy is incomplete.",
          evidence: [evidence("review", "session-policy-review", "Read-only final-state inspection.")],
          outputs: { ok },
        };
      },
    },
  });
  const run = await runEngine(plan, workspacePath, [expiry, audit, verifier]);
  const events = [
    scenarioEvent("plan.rejected", missionId, compiled.profileHash, seed, generatedAt, {
      issueCodes: invalidReview.issues.map((issue) => issue.code),
    }),
    ...run.events,
  ];
  return {
    raw: {
      workspacePath,
      invalidPlanIssueCodes: invalidReview.issues.map((issue) => issue.code),
      invalidPlanRejected: true,
      serializedPlanValid: validateMissionPlan(plan).valid,
      taskSucceededOrder: completedTaskOrder(events),
      eventTypes: events.map((event) => event.type),
    },
    events,
    workerRunCount: run.workerRunCount,
  };
}
