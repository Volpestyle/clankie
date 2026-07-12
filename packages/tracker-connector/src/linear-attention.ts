import { z } from "zod";
import type { AttentionDeliveryAdapter, AttentionDeliveryAttemptInput } from "./human-attention.ts";
import { WorkspaceTrackerBindingSchema, type WorkspaceTrackerBinding } from "./workspace-binding.ts";

const LinearAttentionPrincipalSchema = z.object({
  principalId: z.string().min(1),
  mention: z.string().trim().min(1),
  assignmentId: z.string().min(1).optional(),
  markerId: z.string().min(1).optional(),
});

export const LinearAttentionWorkspaceConfigSchema = z
  .object({
    workspaceId: z.string().min(1),
    binding: WorkspaceTrackerBindingSchema,
    principals: z.record(z.string().min(1), LinearAttentionPrincipalSchema),
  })
  .superRefine((config, context) => {
    for (const [key, principal] of Object.entries(config.principals)) {
      if (key !== principal.principalId) {
        context.addIssue({
          code: "custom",
          path: ["principals", key, "principalId"],
          message: "Linear attention principal key must equal principalId",
        });
      }
    }
    for (const [role, roleBinding] of Object.entries(config.binding.roles)) {
      if (config.principals[roleBinding.principalId] === undefined) {
        context.addIssue({
          code: "custom",
          path: ["binding", "roles", role, "principalId"],
          message: "Linear attention role principal has no provider mapping",
        });
      }
      for (const [index, capability] of roleBinding.capabilities.entries()) {
        if (config.principals[capability.principalId] === undefined) {
          context.addIssue({
            code: "custom",
            path: ["binding", "roles", role, "capabilities", index, "principalId"],
            message: "Linear attention capability principal has no provider mapping",
          });
        }
      }
    }
  });
export type LinearAttentionWorkspaceConfig = z.infer<typeof LinearAttentionWorkspaceConfigSchema>;

/** Credential-owning Linear seam. Idempotency keys must be honored provider-side. */
export interface LinearAttentionClient {
  assignIssue(input: { issueId: string; principalId: string; idempotencyKey: string }): Promise<void>;
  applyIssueLabel(input: { issueId: string; labelId: string; idempotencyKey: string }): Promise<void>;
  createIssueComment(input: { issueId: string; body: string; idempotencyKey: string }): Promise<void>;
}

export interface LinearAttentionRuntime {
  readonly bindingResolver: { resolve(workspaceId: string): WorkspaceTrackerBinding | undefined };
  readonly adapter: AttentionDeliveryAdapter;
}

/**
 * Provider implementation for the three actions required by the default ceremony:
 * assignment, attention marker, and a direct @mention comment containing the
 * smallest typed ask and blocking state.
 */
export function createLinearAttentionRuntime(
  rawConfigs: readonly LinearAttentionWorkspaceConfig[],
  clientForWorkspace: (workspaceId: string) => LinearAttentionClient | undefined,
): LinearAttentionRuntime {
  const configs = new Map(
    rawConfigs.map((raw) => {
      const config = LinearAttentionWorkspaceConfigSchema.parse(raw);
      if (config.binding.workspaceId !== config.workspaceId) {
        throw new Error("Linear attention binding workspace mismatch");
      }
      return [config.workspaceId, config] as const;
    }),
  );

  return {
    bindingResolver: {
      resolve(workspaceId) {
        return configs.get(workspaceId)?.binding;
      },
    },
    adapter: {
      async attempt(input) {
        const config = configs.get(input.workspaceId);
        const client = clientForWorkspace(input.workspaceId);
        if (config === undefined || client === undefined) {
          return { ok: false, unsupported: true, detail: "Linear attention workspace is not configured" };
        }
        const principal = config.principals[input.action.capability.principalId];
        if (principal === undefined) {
          return { ok: false, unsupported: true, detail: "Linear attention principal is not configured" };
        }
        const issueId = input.request.trackerRef?.externalRef;
        if (issueId === undefined) {
          return { ok: false, unsupported: true, detail: "Linear attention request has no issue reference" };
        }

        switch (input.action.capability.kind) {
          case "assign_principal":
            if (principal.assignmentId === undefined) {
              return { ok: false, unsupported: true, detail: "Linear assignee mapping is unavailable" };
            }
            await client.assignIssue({
              issueId,
              principalId: principal.assignmentId,
              idempotencyKey: input.idempotencyToken,
            });
            return { ok: true };
          case "attention_marker":
            if (principal.markerId === undefined) {
              return {
                ok: false,
                unsupported: true,
                detail: "Linear attention-label mapping is unavailable",
              };
            }
            await client.applyIssueLabel({
              issueId,
              labelId: principal.markerId,
              idempotencyKey: input.idempotencyToken,
            });
            return { ok: true };
          case "direct_notify":
          case "comment_notify":
            await client.createIssueComment({
              issueId,
              body: renderLinearAttentionComment(principal.mention, input),
              idempotencyKey: input.idempotencyToken,
            });
            return { ok: true };
          case "surface_notify":
            return { ok: false, unsupported: true, detail: "Linear surface notification is unavailable" };
        }
      },
    },
  };
}

export function renderLinearAttentionComment(mention: string, input: AttentionDeliveryAttemptInput): string {
  return [
    `${mention} ${input.request.actionableAsk}`,
    "",
    `Blocking: ${input.request.blocking ? "yes" : "no"}`,
    `Reply in this agent thread with: \`clankie-response ${input.request.requestId} approve: <rationale>\` (or \`deny\`, \`defer\`, \`clarify\`, \`redirect\`).`,
    `Request: \`${input.request.requestId}\``,
    `Correlation: \`${input.request.correlationId}\``,
  ].join("\n");
}
