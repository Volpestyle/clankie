import { expect, test } from "vitest";
import {
  WorkHandoffIntentSchema,
  WorkItemWriteRequestSchema,
  SubmitOperatorConversationTurnSchema,
} from "@clankie/protocol";
import { projectWorkRepoId } from "../src/project-work-items.ts";
import { personaProjectRoleFixture } from "./persona-project-role-fixture.ts";

test("an explicit busy-worker handoff retains the original native occupant and project while free drops still refuse", async () => {
  // Real captain, durable hire ledger, settings and membership producer. Only
  // OS/Herdr observations are fixture inputs; no live worker is launched.
  const f = await personaProjectRoleFixture();
  f.panes[0]!.agent_status = "working";
  const intent = WorkHandoffIntentSchema.parse({
    personaId: f.ids[0],
    seatId: f.panes[0]!.terminal_id,
    occupantId: f.proofs[0]!.nativeOccupantId,
    projectId: "repo",
  });
  const recipient = await f.captain.prepareWorkHandoffIntent!(intent);
  expect(recipient.ownerName).toBe("Pixel Smith");
  await recipient.guard();
  await expect(f.captain.prepareFreeAgentIntent!(intent)).rejects.toThrow("no longer free");
  await expect(f.captain.prepareWorkHandoffIntent!({ ...intent, projectId: "default" })).rejects.toThrow(
    "changed",
  );
  f.panes[0]!.agent_session.value = "replacement-native-session";
  await expect(recipient.guard()).rejects.toThrow("changed");
  await expect(f.captain.prepareWorkHandoffIntent!(intent)).rejects.toThrow("changed");
});

test("a captured work recipient refuses changed settings and mutually exclusive wire preconditions", async () => {
  const f = await personaProjectRoleFixture();
  const intent = WorkHandoffIntentSchema.parse({
    personaId: f.ids[0],
    seatId: f.panes[0]!.terminal_id,
    occupantId: f.proofs[0]!.nativeOccupantId,
    projectId: "repo",
  });
  const recipient = await f.captain.prepareWorkHandoffIntent!(intent);
  await f.settings.update((current) => ({
    ...current,
    projects: {
      ...current.projects,
      projects: current.projects.projects.map((project) =>
        project.id === "repo" ? { ...project, name: "Changed project" } : project,
      ),
    },
  }));
  expect(() => recipient.assertCurrent()).toThrow();
  const write = {
    repoId: projectWorkRepoId("repo"),
    itemId: "W-original",
    requestId: "2fc88071-a5d6-4fc7-9f97-c5e4c9f6bc85",
    command: { action: "assign", owner: "Pixel Smith" },
    workHandoff: intent,
  };
  expect(WorkItemWriteRequestSchema.safeParse(write).success).toBe(true);
  expect(WorkItemWriteRequestSchema.safeParse({ ...write, freeAgent: intent }).success).toBe(false);
  const message = {
    schemaVersion: 1,
    kind: "message",
    conversationId: "original-thread",
    surfaceClientId: "original-surface",
    expectedRevision: 0,
    message: "Please pick up the original work.",
    workHandoff: intent,
  };
  expect(SubmitOperatorConversationTurnSchema.safeParse(message).success).toBe(true);
  expect(SubmitOperatorConversationTurnSchema.safeParse({ ...message, freeAgent: intent }).success).toBe(
    false,
  );
});
