import { createHash } from "node:crypto";
import {
  LINEAR_AGENT_THREAD_MAX_ACTIVITIES,
  LinearAgentThreadContextSchema,
  TrackerNarrativeWriteResultSchema,
  TrackerNarrativeWriteSchema,
  type LinearAgentThreadContext,
  type LinearChannelTurnRequest,
  type TrackerNarrativeWrite,
  type TrackerNarrativeWriteResult,
} from "@clankie/protocol";
import type { LinearAgentActivity, LinearAgentClient } from "./linear-agent-client.ts";
import type { TrackerClient } from "./types.ts";

export interface LinearAgentRuntimePort {
  readThread(request: LinearChannelTurnRequest): Promise<LinearAgentThreadContext>;
  writeNarrative(write: TrackerNarrativeWrite): Promise<TrackerNarrativeWriteResult>;
}

/** Trusted credential-free runtime over the broker-backed Linear agent client. */
export class CredentialBrokerLinearAgentRuntime implements LinearAgentRuntimePort {
  private readonly client: LinearAgentClient;
  private readonly trackerClient: TrackerClient | undefined;

  public constructor(client: LinearAgentClient, trackerClient?: TrackerClient) {
    this.client = client;
    this.trackerClient = trackerClient;
  }

  public async readThread(request: LinearChannelTurnRequest): Promise<LinearAgentThreadContext> {
    this.assertIdentity(request.identity.workspaceId, request.identity.appUserId);
    if (request.session.appUserId !== request.identity.appUserId) {
      throw new Error("Linear channel session app identity mismatch");
    }
    const session = await this.client.getAgentSession(request.session.id);
    this.assertSessionPage(session, request);
    const activities = [...session.activities.nodes];
    let pageInfo = session.activities.pageInfo;
    const seenCursors = new Set<string>();
    while (pageInfo.hasNextPage) {
      if (activities.length >= LINEAR_AGENT_THREAD_MAX_ACTIVITIES) {
        throw new Error("Linear agent thread exceeds the bounded activity limit");
      }
      const cursor = pageInfo.endCursor ?? undefined;
      if (cursor === undefined || seenCursors.has(cursor)) {
        throw new Error("Linear agent thread returned invalid pagination metadata");
      }
      seenCursors.add(cursor);
      const page = await this.client.getAgentSession(request.session.id, cursor);
      this.assertSessionPage(page, request);
      activities.push(...page.activities.nodes);
      if (activities.length > LINEAR_AGENT_THREAD_MAX_ACTIVITIES) {
        throw new Error("Linear agent thread exceeds the bounded activity limit");
      }
      pageInfo = page.activities.pageInfo;
    }

    return LinearAgentThreadContextSchema.parse({
      workspaceId: this.client.identity.workspaceId,
      appUserId: this.client.identity.appUserId,
      sessionId: session.id,
      issue: session.issue,
      rootComment:
        session.comment === null || session.comment === undefined
          ? null
          : {
              id: session.comment.id,
              body: session.comment.body,
              issueId: session.comment.issueId,
            },
      activities: activities.map((activity) => ({
        id: activity.id,
        userId: activity.user.id,
        type: activity.content.type,
        body: renderActivityContent(activity),
        createdAt: activity.createdAt,
      })),
    });
  }

  private assertSessionPage(
    session: Awaited<ReturnType<LinearAgentClient["getAgentSession"]>>,
    request: LinearChannelTurnRequest,
  ): void {
    if (session.id !== request.session.id) throw new Error("Linear returned a different agent session");
    if (session.appUser.id !== this.client.identity.appUserId) {
      throw new Error("Linear session belongs to a different app identity");
    }
    if (!session.issue || session.issue.id !== request.issue.id) {
      throw new Error("Linear session issue does not match the channel turn");
    }
    const expectedRootCommentId = request.trigger.rootCommentId;
    if (
      (expectedRootCommentId === null && session.comment != null) ||
      (expectedRootCommentId !== null && session.comment?.id !== expectedRootCommentId)
    ) {
      throw new Error("Linear root comment does not match the channel turn");
    }
    if (session.comment && session.comment.issueId !== session.issue.id) {
      throw new Error("Linear root comment belongs to a different issue");
    }
  }

  public async writeNarrative(rawWrite: TrackerNarrativeWrite): Promise<TrackerNarrativeWriteResult> {
    const write = TrackerNarrativeWriteSchema.parse(rawWrite);
    this.assertIdentity(write.identity.workspaceId, write.identity.appUserId);
    if (write.action === "tracker.comment.create") {
      if (this.trackerClient === undefined) {
        throw new Error("Linear issue-comment runtime is unavailable");
      }
      const appIdentity = await this.trackerClient.getAppIdentity();
      if (appIdentity.id !== this.client.identity.appUserId) {
        throw new Error("Linear tracker client belongs to a different app identity");
      }
      const comment = await this.trackerClient.postComment({
        ref: {
          connector: "linear",
          workspaceId: write.identity.workspaceId,
          issueId: write.issueId,
        },
        body: write.content,
        idempotencyKey: write.idempotencyKey,
      });
      return TrackerNarrativeWriteResultSchema.parse({
        id: comment.commentId,
        action: write.action,
        appUserId: appIdentity.id,
      });
    }
    if (write.action === "tracker.reaction.create") {
      const reaction = await this.client.reactionCreate({
        commentId: write.commentId as string,
        emoji: write.content,
        reactionId: stableUuid(write.idempotencyKey),
      });
      if (reaction.emoji !== write.content) throw new Error("Linear returned a different reaction");
      return TrackerNarrativeWriteResultSchema.parse({
        id: reaction.id,
        action: write.action,
        appUserId: this.client.identity.appUserId,
      });
    }

    const type = activityType(write.action);
    const activity = await this.client.createAgentActivity({
      agentSessionId: write.agentSessionId,
      activityId: stableUuid(write.idempotencyKey),
      ...(write.ephemeral === undefined ? {} : { ephemeral: write.ephemeral }),
      content: { type, body: write.content },
    });
    if (activity.user.id !== this.client.identity.appUserId) {
      throw new Error("Linear activity result belongs to a different app identity");
    }
    if (
      activity.content.type !== type ||
      !("body" in activity.content) ||
      activity.content.body !== write.content
    ) {
      throw new Error("Linear returned different narrative activity content");
    }
    return TrackerNarrativeWriteResultSchema.parse({
      id: activity.id,
      action: write.action,
      appUserId: activity.user.id,
    });
  }

  private assertIdentity(workspaceId: string, appUserId: string): void {
    if (workspaceId !== this.client.identity.workspaceId) {
      throw new Error("Linear runtime workspace identity mismatch");
    }
    if (appUserId !== this.client.identity.appUserId) {
      throw new Error("Linear runtime app identity mismatch");
    }
  }
}

function activityType(
  action: Exclude<TrackerNarrativeWrite["action"], "tracker.comment.create" | "tracker.reaction.create">,
): "elicitation" | "response" | "thought" {
  switch (action) {
    case "tracker.agent-activity.thought.create":
      return "thought";
    case "tracker.agent-activity.response.create":
      return "response";
    case "tracker.agent-activity.elicitation.create":
      return "elicitation";
  }
}

function renderActivityContent(activity: LinearAgentActivity): string {
  if ("body" in activity.content) return activity.content.body;
  return [activity.content.action, activity.content.parameter, activity.content.result]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n");
}

function stableUuid(key: string): string {
  const bytes = createHash("sha256").update(key).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
