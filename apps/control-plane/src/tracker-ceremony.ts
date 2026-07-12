import { projectCaptainCeremony, type CompiledDoctrine } from "@clankie/doctrine";
import {
  HumanAttentionRequestSchema,
  type DomainEvent,
  type HumanAttentionResponse,
} from "@clankie/protocol";
import {
  correlateAgentSessionToAttention,
  deliverHumanAttention,
  validateIssueDraft,
  WorkspaceTrackerBindingSchema,
  type AttentionDeliveryAdapter,
  type AttentionDeliveryResult,
  type AttentionDeliveryStore,
  type PendingAttentionRecord,
  type TrackerPolicyGateway,
} from "@clankie/tracker-connector";
import { z } from "zod";

export const ValidateIssueDraftRequestSchema = z
  .object({
    draft: z.unknown(),
    bodyMarkdown: z.string().optional(),
  })
  .strict();

export const DeliverHumanAttentionRequestSchema = z
  .object({
    request: z.unknown(),
    binding: z.unknown(),
  })
  .strict();

export const CorrelateAttentionRequestSchema = z
  .object({
    pending: z.object({
      request: z.unknown(),
      workspaceId: z.string().min(1),
      issueId: z.string().min(1).optional(),
      agentSessionId: z.string().min(1).optional(),
      rootCommentId: z.string().nullable().optional(),
    }),
    event: z.unknown(),
    responseId: z.string().min(1),
    actorRole: z.enum(["operator", "captain", "product_steward", "reviewer", "verifier"]),
    decision: z.enum(["approve", "deny", "defer", "clarify", "redirect"]).optional(),
    rationale: z.string().min(1).optional(),
  })
  .strict();

export interface TrackerCeremonyRuntime {
  validateDraft(raw: unknown): ReturnType<typeof validateIssueDraft>;
  deliverAttention(raw: unknown): Promise<AttentionDeliveryResult>;
  correlate(raw: unknown): HumanAttentionResponse | { ok: false; reason: string };
}

export function createTrackerCeremonyRuntime(input: {
  readonly doctrine: CompiledDoctrine;
  readonly policy: TrackerPolicyGateway;
  readonly adapter: AttentionDeliveryAdapter;
  readonly store: AttentionDeliveryStore;
  readonly clock?: () => Date;
}): TrackerCeremonyRuntime {
  const projection = projectCaptainCeremony(input.doctrine);
  return {
    validateDraft(raw) {
      const parsed = ValidateIssueDraftRequestSchema.parse(raw);
      return validateIssueDraft({
        draft: parsed.draft,
        projection,
        ...(parsed.bodyMarkdown === undefined ? {} : { bodyMarkdown: parsed.bodyMarkdown }),
      });
    },
    async deliverAttention(raw) {
      const parsed = DeliverHumanAttentionRequestSchema.parse(raw);
      return deliverHumanAttention({
        request: parsed.request,
        binding: WorkspaceTrackerBindingSchema.parse(parsed.binding),
        projection,
        adapter: input.adapter,
        policy: input.policy,
        store: input.store,
        ...(input.clock === undefined ? {} : { clock: input.clock }),
      });
    },
    correlate(raw) {
      const parsed = CorrelateAttentionRequestSchema.parse(raw);
      const pending: PendingAttentionRecord = {
        request: HumanAttentionRequestSchema.parse(parsed.pending.request),
        workspaceId: parsed.pending.workspaceId,
        ...(parsed.pending.issueId === undefined ? {} : { issueId: parsed.pending.issueId }),
        ...(parsed.pending.agentSessionId === undefined
          ? {}
          : { agentSessionId: parsed.pending.agentSessionId }),
        ...(parsed.pending.rootCommentId === undefined
          ? {}
          : { rootCommentId: parsed.pending.rootCommentId }),
      };
      const response = correlateAgentSessionToAttention({
        pending,
        event: parsed.event as DomainEvent,
        responseId: parsed.responseId,
        actorRole: parsed.actorRole,
        ...(parsed.decision === undefined ? {} : { decision: parsed.decision }),
        ...(parsed.rationale === undefined ? {} : { rationale: parsed.rationale }),
        ...(input.clock === undefined ? {} : { clock: input.clock }),
      });
      if (response === undefined) {
        return { ok: false as const, reason: "no_correlation" };
      }
      return response;
    },
  };
}

/** In-memory store suitable for tests and single-process control plane. */
export class InMemoryAttentionDeliveryStore implements AttentionDeliveryStore {
  private readonly entries = new Map<string, { fingerprint: string; result: AttentionDeliveryResult }>();

  public async get(key: string): Promise<AttentionDeliveryResult | undefined> {
    return this.entries.get(key)?.result;
  }

  public async put(key: string, fingerprint: string, result: AttentionDeliveryResult): Promise<void> {
    this.entries.set(key, { fingerprint, result });
  }
}

/** Default adapter that marks all capabilities unsupported (honest without Linear extension). */
export class UnsupportedAttentionAdapter implements AttentionDeliveryAdapter {
  public async attempt(): Promise<{ ok: boolean; unsupported?: boolean; detail?: string }> {
    return {
      ok: false,
      unsupported: true,
      detail: "No attention delivery adapter is configured for this control plane.",
    };
  }
}
