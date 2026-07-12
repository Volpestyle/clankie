import { DomainEventSchema, type DomainEvent } from "@clankie/protocol";
import { z } from "zod";

const LinearWebhookUserSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  url: z.string().url(),
  avatarUrl: z.string().url().nullable().optional(),
});

const LinearWebhookCommentSchema = z.object({
  id: z.string().min(1),
  body: z.string(),
  issueId: z.string().min(1).nullable().optional(),
  userId: z.string().min(1).nullable().optional(),
});

const LinearWebhookIssueSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  teamId: z.string().min(1),
  url: z.string().url(),
});

const LinearAgentSessionWebhookPayloadSchema = z.object({
  id: z.string().min(1),
  appUserId: z.string().min(1),
  organizationId: z.string().min(1),
  status: z.enum(["pending", "active", "awaitingInput", "complete", "error", "stale"]),
  type: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable().optional(),
  endedAt: z.string().datetime().nullable().optional(),
  summary: z.string().nullable().optional(),
  url: z.string().url().nullable().optional(),
  issueId: z.string().min(1).nullable().optional(),
  issue: LinearWebhookIssueSchema.nullable().optional(),
  commentId: z.string().min(1).nullable().optional(),
  comment: LinearWebhookCommentSchema.nullable().optional(),
  sourceCommentId: z.string().min(1).nullable().optional(),
  creatorId: z.string().min(1).nullable().optional(),
  creator: LinearWebhookUserSchema.nullable().optional(),
  sourceMetadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const LinearPromptActivityWebhookPayloadSchema = z.object({
  id: z.string().min(1),
  agentSessionId: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  sourceCommentId: z.string().min(1).nullable().optional(),
  userId: z.string().min(1),
  user: LinearWebhookUserSchema,
  content: z.object({ type: z.literal("prompt"), body: z.string().min(1) }),
  signal: z.string().nullable().optional(),
  signalMetadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const LinearAgentSessionEventBaseSchema = z.object({
  type: z.literal("AgentSessionEvent"),
  organizationId: z.string().min(1),
  oauthClientId: z.string().min(1),
  appUserId: z.string().min(1),
  createdAt: z.string().datetime(),
  webhookId: z.string().min(1),
  webhookTimestamp: z.number().finite().nonnegative(),
  agentSession: LinearAgentSessionWebhookPayloadSchema,
  previousComments: z.array(LinearWebhookCommentSchema).nullable().optional(),
  guidance: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
});

const LinearAgentSessionCreatedWebhookSchema = LinearAgentSessionEventBaseSchema.extend({
  action: z.literal("created"),
  promptContext: z.string().min(1),
  agentActivity: z.null().optional(),
});

const LinearAgentSessionPromptedWebhookSchema = LinearAgentSessionEventBaseSchema.extend({
  action: z.literal("prompted"),
  promptContext: z.string().nullable().optional(),
  agentActivity: LinearPromptActivityWebhookPayloadSchema,
});

export const LinearAgentSessionEventWebhookSchema = z
  .discriminatedUnion("action", [
    LinearAgentSessionCreatedWebhookSchema,
    LinearAgentSessionPromptedWebhookSchema,
  ])
  .superRefine((payload, context) => {
    const session = payload.agentSession;
    const inconsistent = (message: string, path: PropertyKey[]) =>
      context.addIssue({ code: "custom", message, path });
    if (session.appUserId !== payload.appUserId) {
      inconsistent("Session app user does not match webhook app user", ["agentSession", "appUserId"]);
    }
    if (session.organizationId !== payload.organizationId) {
      inconsistent("Session organization does not match webhook organization", [
        "agentSession",
        "organizationId",
      ]);
    }
    if (session.issue && session.issueId !== session.issue.id) {
      inconsistent("Session issue identity is inconsistent", ["agentSession", "issueId"]);
    }
    if (session.comment && session.commentId !== session.comment.id) {
      inconsistent("Session comment identity is inconsistent", ["agentSession", "commentId"]);
    }
    if (session.comment?.issueId && session.comment.issueId !== session.issueId) {
      inconsistent("Session comment belongs to a different issue", ["agentSession", "comment", "issueId"]);
    }
    if (session.creator && session.creatorId !== session.creator.id) {
      inconsistent("Session creator identity is inconsistent", ["agentSession", "creatorId"]);
    }
    for (const [index, comment] of (payload.previousComments ?? []).entries()) {
      if (comment.issueId && comment.issueId !== session.issueId) {
        inconsistent("Previous comment belongs to a different issue", ["previousComments", index, "issueId"]);
      }
    }
    const actorId = payload.action === "prompted" ? payload.agentActivity.userId : session.creatorId;
    if (actorId === payload.appUserId) {
      inconsistent("Agent session event is self-authored", [
        payload.action === "prompted" ? "agentActivity" : "agentSession",
        payload.action === "prompted" ? "userId" : "creatorId",
      ]);
    }
    if (payload.action === "prompted") {
      if (payload.agentActivity.agentSessionId !== session.id) {
        inconsistent("Prompt activity belongs to a different session", ["agentActivity", "agentSessionId"]);
      }
      if (payload.agentActivity.userId !== payload.agentActivity.user.id) {
        inconsistent("Prompt actor identity is inconsistent", ["agentActivity", "userId"]);
      }
    }
  });
export type LinearAgentSessionEventWebhook = z.infer<typeof LinearAgentSessionEventWebhookSchema>;

export const LinearAgentSessionEventContextSchema = z.object({
  deliveryId: z.string().uuid(),
  appUserId: z.string().min(1),
  missionId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  workerRunId: z.string().min(1).optional(),
  correlationId: z.string().min(1),
  profileHash: z.string().min(1),
});
export type LinearAgentSessionEventContext = z.infer<typeof LinearAgentSessionEventContextSchema>;

/** Maps a verified Linear webhook body and Linear-Delivery header into a protocol event. */
export function parseLinearAgentSessionEvent(
  rawPayload: unknown,
  rawContext: LinearAgentSessionEventContext,
): DomainEvent {
  const payload = LinearAgentSessionEventWebhookSchema.parse(rawPayload);
  const context = LinearAgentSessionEventContextSchema.parse(rawContext);
  if (payload.appUserId !== context.appUserId) {
    throw new Error("Linear webhook app identity does not match the configured app identity");
  }
  const session = payload.agentSession;
  if (!session.issue || !session.issueId) {
    throw new Error("Linear agent session is not attached to an issue");
  }
  const actor = payload.action === "prompted" ? payload.agentActivity.user : session.creator;
  const activity = payload.action === "prompted" ? payload.agentActivity : undefined;
  const commentId = activity?.sourceCommentId ?? session.sourceCommentId ?? session.commentId ?? undefined;

  return DomainEventSchema.parse({
    id: `linear-agent-session:${context.deliveryId}`,
    occurredAt: payload.createdAt,
    missionId: context.missionId,
    ...(context.taskId === undefined ? {} : { taskId: context.taskId }),
    ...(context.workerRunId === undefined ? {} : { workerRunId: context.workerRunId }),
    correlationId: context.correlationId,
    causationId: payload.webhookId,
    profileHash: context.profileHash,
    type: `tracker.agent-session.${payload.action}`,
    data: {
      connector: "linear",
      action: payload.action,
      delivery: {
        id: context.deliveryId,
        webhookId: payload.webhookId,
        timestamp: payload.webhookTimestamp,
      },
      correlation: { id: context.correlationId },
      organization: { id: payload.organizationId },
      oauthClient: { id: payload.oauthClientId },
      appActor: { id: payload.appUserId },
      issue: {
        id: session.issue.id,
        identifier: session.issue.identifier,
        url: session.issue.url,
      },
      comment: {
        id: commentId ?? null,
        rootId: session.commentId ?? null,
        actorId: activity?.userId ?? session.comment?.userId ?? null,
      },
      actor: actor ? { id: actor.id, name: actor.name, email: actor.email, url: actor.url } : null,
      session: {
        id: session.id,
        appUserId: session.appUserId,
        organizationId: session.organizationId,
        issueId: session.issueId,
        commentId: session.commentId ?? null,
        sourceCommentId: session.sourceCommentId ?? null,
        status: session.status,
        url: session.url ?? null,
      },
      ...(activity
        ? {
            activity: {
              id: activity.id,
              type: activity.content.type,
              body: activity.content.body,
              actorId: activity.userId,
              sourceCommentId: activity.sourceCommentId ?? null,
            },
          }
        : {}),
      ...(payload.action === "created"
        ? {
            promptContext: payload.promptContext,
            previousComments: (payload.previousComments ?? []).map((comment) => ({
              id: comment.id,
              issueId: comment.issueId ?? null,
              actorId: comment.userId ?? null,
              body: comment.body,
            })),
            guidance: payload.guidance ?? [],
          }
        : {}),
    },
  });
}
