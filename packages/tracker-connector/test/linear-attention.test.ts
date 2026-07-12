import type { HumanAttentionRequest } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { createLinearAttentionRuntime, type LinearAttentionClient } from "../src/linear-attention.ts";

const request: HumanAttentionRequest = {
  schemaVersion: 1,
  requestId: "attention-1",
  missionId: "mission-1",
  correlationId: "correlation-1",
  targetRole: "operator",
  requestKind: "decision_needed",
  actionableAsk: "Choose the launch option.",
  blocking: true,
  authorityImpact: "narrow",
  urgency: "blocking",
  notificationSurfaces: ["operator_inbox"],
  trackerRef: { correlationId: "correlation-1", externalRef: "issue-1" },
  createdAt: "2026-07-12T12:00:00.000Z",
};

describe("Linear attention runtime", () => {
  it("maps operator assignment, marker, and direct mention with stable provider keys", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client: LinearAttentionClient = {
      async assignIssue(input) {
        calls.push({ kind: "assign", ...input });
      },
      async applyIssueLabel(input) {
        calls.push({ kind: "label", ...input });
      },
      async createIssueComment(input) {
        calls.push({ kind: "comment", ...input });
      },
    };
    const runtime = createLinearAttentionRuntime(
      [
        {
          workspaceId: "workspace-1",
          binding: {
            schemaVersion: 1,
            workspaceId: "workspace-1",
            revision: "1",
            roles: {
              operator: {
                principalId: "linear-user-james",
                capabilities: [
                  { kind: "assign_principal", principalId: "linear-user-james" },
                  { kind: "attention_marker", principalId: "linear-user-james" },
                  { kind: "direct_notify", principalId: "linear-user-james" },
                ],
              },
            },
          },
          principals: {
            "linear-user-james": {
              principalId: "linear-user-james",
              mention: "@James Volpe",
              assignmentId: "linear-user-james",
              markerId: "linear-label-needs-human",
            },
          },
        },
      ],
      (workspaceId) => (workspaceId === "workspace-1" ? client : undefined),
    );

    const binding = runtime.bindingResolver.resolve("workspace-1")!;
    for (const capability of binding.roles.operator!.capabilities) {
      const result = await runtime.adapter.attempt({
        workspaceId: "workspace-1",
        request,
        idempotencyToken: `token-${capability.kind}`,
        action: {
          capability,
          targetRole: "operator",
          directNotification: "required",
          isFallback: false,
        },
      });
      expect(result.ok).toBe(true);
    }

    expect(calls).toEqual([
      {
        kind: "assign",
        issueId: "issue-1",
        principalId: "linear-user-james",
        idempotencyKey: "token-assign_principal",
      },
      {
        kind: "label",
        issueId: "issue-1",
        labelId: "linear-label-needs-human",
        idempotencyKey: "token-attention_marker",
      },
      expect.objectContaining({
        kind: "comment",
        issueId: "issue-1",
        idempotencyKey: "token-direct_notify",
        body: expect.stringContaining("@James Volpe Choose the launch option."),
      }),
    ]);
  });
});
