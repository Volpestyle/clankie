import type { DomainEvent, MissionPlan, TaskRole } from "@clankie/protocol";
import { z } from "zod";

export const TRACKER_AUTHORITY_ROLES = ["product_intent", "priority", "acceptance_criteria"] as const;

export const TrackerIssueRefSchema = z.object({
  connector: z.string().min(1),
  workspaceId: z.string().min(1),
  issueId: z.string().min(1),
});
export type TrackerIssueRef = z.infer<typeof TrackerIssueRefSchema>;

export const TrackerPrioritySchema = z.object({
  value: z.number().int().nonnegative().nullable(),
  label: z.string().min(1),
});
export type TrackerPriority = z.infer<typeof TrackerPrioritySchema>;

export const TrackerStateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
});
export type TrackerState = z.infer<typeof TrackerStateSchema>;

export const TrackerCompletionStateSchema = TrackerStateSchema.extend({
  type: z.enum(["completed", "canceled"]),
});

export const TrackerIssueSchema = z.object({
  ref: TrackerIssueRefSchema,
  identifier: z.string().min(1),
  url: z.string().url(),
  revision: z.string().min(1),
  intent: z.object({ title: z.string().min(1), description: z.string() }),
  priority: TrackerPrioritySchema,
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  state: TrackerStateSchema,
});
export type TrackerIssue = z.infer<typeof TrackerIssueSchema>;

export const TrackerAppIdentitySchema = z.object({
  kind: z.literal("app"),
  id: z.string().min(1),
  displayName: z.string().min(1),
});
export type TrackerAppIdentity = z.infer<typeof TrackerAppIdentitySchema>;

export const TrackerMissionContractSchema = z.object({
  schemaVersion: z.literal(1),
  missionId: z.string().min(1),
  source: TrackerIssueSchema,
  appIdentity: TrackerAppIdentitySchema,
  importedAt: z.string().datetime(),
});
export type TrackerMissionContract = z.infer<typeof TrackerMissionContractSchema>;

export interface TrackerCommentInput {
  ref: TrackerIssueRef;
  body: string;
  idempotencyKey: string;
}

export const TrackerIssueMutationSchema = z.object({
  priority: TrackerPrioritySchema.optional(),
  completionState: TrackerCompletionStateSchema.optional(),
});
export type TrackerIssueMutation = z.infer<typeof TrackerIssueMutationSchema>;

/** Provider-neutral privileged port with no credential or author override. */
export interface TrackerClient {
  readonly connector: string;
  getAppIdentity(): Promise<TrackerAppIdentity>;
  getIssue(ref: TrackerIssueRef): Promise<TrackerIssue>;
  postComment(input: TrackerCommentInput): Promise<{ commentId: string }>;
  mirrorAssignment(input: {
    ref: TrackerIssueRef;
    appIdentityId: string;
    idempotencyKey: string;
  }): Promise<void>;
  mutateIssue(input: {
    ref: TrackerIssueRef;
    mutation: TrackerIssueMutation;
    idempotencyKey: string;
  }): Promise<void>;
}

export const TrackerWriteActionSchema = z.enum([
  "tracker.comment.create",
  "tracker.assignment.mirror",
  "tracker.assignment.update",
  "tracker.attention.marker.apply",
  "tracker.priority.update",
  "tracker.completion.update",
]);
export type TrackerWriteAction = z.infer<typeof TrackerWriteActionSchema>;

export interface TrackerWriteRequest {
  action: TrackerWriteAction;
  riskClass: "reversible-write" | "irreversible-write";
  missionId: string;
  ref: TrackerIssueRef;
  idempotencyKey: string;
  correlationId?: string;
  content?: string;
}

export interface TrackerPolicyDecision {
  effect: "allow" | "deny" | "require_approval";
  reason: string;
  obligations?: readonly string[];
}

export interface TrackerPolicyGateway {
  authorize(request: TrackerWriteRequest): Promise<TrackerPolicyDecision>;
}

export interface TrackerEventAttribution {
  role: TaskRole | "system";
  nativeSessionIds?: readonly string[];
}

export interface TrackerDriftReport {
  missionId: string;
  ref: TrackerIssueRef;
  baselineRevision: string;
  upstreamRevision: string;
  changedFields: Array<"intent" | "priority" | "acceptanceCriteria">;
  baseline: Pick<TrackerIssue, "intent" | "priority" | "acceptanceCriteria">;
  upstream: Pick<TrackerIssue, "intent" | "priority" | "acceptanceCriteria">;
}

export interface TrackerMirrorPort {
  importMission(missionId: string, ref: TrackerIssueRef): Promise<TrackerMissionContract>;
  restore(contract: TrackerMissionContract): void;
  validatePlan(plan: MissionPlan): void;
  reconcile(missionId: string): Promise<TrackerDriftReport | undefined>;
  publish(event: DomainEvent, attribution: TrackerEventAttribution): Promise<void>;
  mutate(missionId: string, mutation: TrackerIssueMutation, idempotencyKey: string): Promise<void>;
}
