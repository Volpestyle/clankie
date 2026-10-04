import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  OperatorConversationServiceRequestSchema,
  createOperatorConversationServiceClient,
} from "../src/index.ts";
import { ProjectProposalDraftSchema } from "../src/projects.ts";
import { hostedOperatorAllows } from "../src/hosted-operator.ts";
const target = {
  conversationId: "workspace",
  incarnationId: randomUUID(),
  requestId: randomUUID(),
  expectedRevision: 3,
  proposalId: randomUUID(),
  artifactSha256: "a".repeat(64),
  expectedProjectsRevision: "b".repeat(64),
};
it("strict explicit confirmation accepts immutable target only, never preference/enrollment/auth payload", () => {
  const request = { schemaVersion: 1, op: "project_proposal_confirm", ...target };
  expect(OperatorConversationServiceRequestSchema.safeParse(request).success).toBe(true);
  expect(hostedOperatorAllows("POST", "/operator/v1/dispatch", JSON.stringify(request))).toBe(true);
  for (const extra of [
    { answer: "yes" },
    { command: {} },
    { principal: "owner" },
    { workspacePath: "/fake" },
    { machineId: "kh2" },
  ])
    expect(OperatorConversationServiceRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false);
  expect(
    ProjectProposalDraftSchema.safeParse({
      projectId: "one",
      name: "One",
      prompt: "review",
      workerCap: 0,
      roles: [{ role: "Builder", concurrencyCap: null }],
      fleet: { size: "max" },
    }).success,
  ).toBe(true);
});
it("explicit client sends one exact confirm and never retries transport uncertainty", async () => {
  const dispatch = vi.fn(async () => {
    throw Error("lost response");
  });
  const client = createOperatorConversationServiceClient(dispatch);
  await expect(client.projectProposalConfirm!(target)).rejects.toThrow("lost response");
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0]).toEqual([{ schemaVersion: 1, op: "project_proposal_confirm", ...target }]);
});
it("read is a separate exact locator operation, compatible with strict older question DTOs", async () => {
  const { conversationId, incarnationId, requestId } = target;
  const dispatch = vi.fn(async (request) => ({
    op: request.op,
    schemaVersion: 1 as const,
    result: { status: "uncertain" as const },
  }));
  const client = createOperatorConversationServiceClient(dispatch);
  expect(await client.projectProposalGet!({ conversationId, incarnationId, requestId })).toEqual({
    status: "uncertain",
  });
  expect(dispatch.mock.calls[0]![0]).toEqual({
    op: "project_proposal_get",
    schemaVersion: 1,
    conversationId,
    incarnationId,
    requestId,
  });
});
