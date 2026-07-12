import type { ClankieApiClient } from "@clankie/api-client";
import {
  LinearChannelTurnRequestSchema,
  type CaptainChannelTurnResult,
  type LinearChannelIdentity,
  type LinearChannelTurnRequest,
  type TrackerNarrativeWrite,
  type TrackerNarrativeWriteResult,
} from "@clankie/protocol";
import { LinearAgentSessionEventWebhookSchema } from "@clankie/tracker-connector";
import type { VerifiedLinearAgentSessionEvent } from "../../relay/src/linear-webhook-protocol.ts";

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_ISSUE_CAP = 20;
const DEFAULT_WORKSPACE_CAP = 100;
const DEFAULT_MAX_RETAINED_DELIVERIES = 50_000;
const ACK_TARGET_MS = 10_000;
const DELIVERY_RETENTION_MS = 7 * 60 * 60 * 1_000;

export interface LinearChannelApi {
  submitCaptainChannelTurn(input: LinearChannelTurnRequest): Promise<CaptainChannelTurnResult>;
  writeTrackerNarrative(input: TrackerNarrativeWrite): Promise<TrackerNarrativeWriteResult>;
}

export type LinearChannelAdapterIdentity = Omit<LinearChannelIdentity, "correlationId">;

export interface LinearChannelAdapterOptions {
  readonly api: LinearChannelApi | ClankieApiClient;
  readonly identity: LinearChannelAdapterIdentity;
  readonly approvalSurfaceUrl: string;
  readonly clock?: () => number;
  readonly windowMs?: number;
  readonly maxEventsPerIssue?: number;
  readonly maxEventsPerWorkspace?: number;
  readonly maxRetainedDeliveries?: number;
  readonly evidence?: LinearChannelEvidenceSink;
}

export type LinearChannelOutcome =
  | { readonly status: "handled"; readonly disposition: "approval_refused" | "elicitation" | "response" }
  | { readonly status: "ignored"; readonly reason: LinearChannelIgnoreReason };

export type LinearChannelIgnoreReason =
  | "app_identity_mismatch"
  | "duplicate_delivery"
  | "issue_cap"
  | "non_human_trigger"
  | "root_comment_issue_mismatch"
  | "session_identity_mismatch"
  | "session_issue_mismatch"
  | "unsupported_event"
  | "workspace_cap";

export interface LinearChannelEvidence {
  readonly service: "linear-channel-adapter";
  readonly outcome: "ack_scheduled" | "captain_submitted" | "handled" | "ignored";
  readonly timestampMs: number;
  readonly missionId: string;
  readonly taskId: string;
  readonly workerRunId: string;
  readonly correlationId: string;
  readonly deliveryId: string;
  readonly issueId?: string;
  readonly reason?: string;
  readonly ackLatencyMs?: number;
}

export type LinearChannelEvidenceSink = (evidence: LinearChannelEvidence) => void;

export class LinearChannelBackpressureError extends Error {
  public readonly code = "delivery_retention_capacity";

  public constructor() {
    super("Linear channel delivery retention capacity is exhausted");
    this.name = "LinearChannelBackpressureError";
  }
}

interface EligibleTrigger {
  readonly request: LinearChannelTurnRequest;
}

const noopEvidence: LinearChannelEvidenceSink = () => undefined;

/**
 * Credential-free channel adapter. It accepts only events independently verified by the
 * VUH-800 local bridge and treats all parsed webhook fields as untrusted identities.
 */
export class LinearChannelAdapter {
  private readonly api: LinearChannelApi;
  private readonly identity: LinearChannelAdapterIdentity;
  private readonly approvalSurfaceUrl: URL;
  private readonly clock: () => number;
  private readonly limits: FixedWindowLimits;
  private readonly evidence: LinearChannelEvidenceSink;
  private readonly maxRetainedDeliveries: number;
  private readonly deliveries = new Map<
    string,
    { operation: Promise<LinearChannelOutcome>; expiresAtMs: number }
  >();

  public constructor(options: LinearChannelAdapterOptions) {
    this.api = options.api;
    this.identity = options.identity;
    this.approvalSurfaceUrl = assertAuthenticatedSurface(options.approvalSurfaceUrl);
    this.clock = options.clock ?? Date.now;
    this.limits = new FixedWindowLimits({
      clock: this.clock,
      windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
      issueCap: options.maxEventsPerIssue ?? DEFAULT_ISSUE_CAP,
      workspaceCap: options.maxEventsPerWorkspace ?? DEFAULT_WORKSPACE_CAP,
    });
    this.evidence = options.evidence ?? noopEvidence;
    this.maxRetainedDeliveries = options.maxRetainedDeliveries ?? DEFAULT_MAX_RETAINED_DELIVERIES;
    if (!Number.isInteger(this.maxRetainedDeliveries) || this.maxRetainedDeliveries < 1) {
      throw new Error("maxRetainedDeliveries must be a positive integer");
    }
  }

  public async consume(event: VerifiedLinearAgentSessionEvent): Promise<LinearChannelOutcome> {
    this.pruneDeliveries();
    const current = this.deliveries.get(event.deliveryId);
    if (current !== undefined) {
      this.emit("ignored", event, undefined, "duplicate_delivery");
      await current.operation;
      return { status: "ignored", reason: "duplicate_delivery" };
    }

    const eligibility = this.toEligibleTrigger(event);
    if ("reason" in eligibility) {
      this.emit("ignored", event, eligibility.issueId, eligibility.reason);
      return { status: "ignored", reason: eligibility.reason };
    }
    if (this.deliveries.size >= this.maxRetainedDeliveries) {
      this.emit("ignored", event, eligibility.request.issue.id, "delivery_retention_capacity");
      throw new LinearChannelBackpressureError();
    }

    const operation = this.consumeEligible(event, eligibility.request);
    this.deliveries.set(event.deliveryId, {
      operation,
      expiresAtMs: this.clock() + DELIVERY_RETENTION_MS,
    });
    try {
      return await operation;
    } catch (error) {
      if (this.deliveries.get(event.deliveryId)?.operation === operation) {
        this.deliveries.delete(event.deliveryId);
      }
      throw error;
    }
  }

  private async consumeEligible(
    event: VerifiedLinearAgentSessionEvent,
    request: LinearChannelTurnRequest,
  ): Promise<LinearChannelOutcome> {
    const cap = this.limits.take(request.identity.workspaceId, request.issue.id);
    if (cap !== "allowed") {
      this.emit("ignored", event, request.issue.id, cap);
      return { status: "ignored", reason: cap };
    }

    // This call is deliberately initiated before approval inspection or any captain/model turn.
    const ackLatencyMs = Math.max(0, this.clock() - event.receivedAtMs);
    const acknowledgement = this.api.writeTrackerNarrative(
      this.narrative(request, "ack", "tracker.agent-activity.thought.create", "I’m looking into this.", true),
    );
    // Observe early rejection while the captain is still running; Promise.all below
    // remains authoritative for the delivery outcome.
    void acknowledgement.catch(() => undefined);
    this.emit("ack_scheduled", event, request.issue.id, undefined, ackLatencyMs);
    if (ackLatencyMs > ACK_TARGET_MS) {
      await acknowledgement;
      throw new Error("Linear acknowledgement missed the 10 second scheduling target");
    }

    let finalWrite: Promise<TrackerNarrativeWriteResult>;
    let disposition: "approval_refused" | "elicitation" | "response";
    if (isApprovalShaped(request.trigger.body)) {
      disposition = "approval_refused";
      finalWrite = this.api.writeTrackerNarrative(
        this.narrative(
          request,
          "approval-refusal",
          "tracker.agent-activity.response.create",
          this.approvalRefusal(request),
        ),
      );
    } else {
      this.emit("captain_submitted", event, request.issue.id);
      const result = await this.api.submitCaptainChannelTurn(request);
      if (result.state === "failed") {
        await acknowledgement;
        throw new Error(`Captain channel turn failed: ${result.code}`);
      }
      if (result.state === "waiting_user" && (result.approvalRequired || isApprovalShaped(result.prompt))) {
        disposition = "approval_refused";
        finalWrite = this.api.writeTrackerNarrative(
          this.narrative(
            request,
            "approval-refusal",
            "tracker.agent-activity.response.create",
            this.approvalRefusal(request),
          ),
        );
      } else if (result.state === "waiting_user") {
        disposition = "elicitation";
        finalWrite = this.api.writeTrackerNarrative(
          this.narrative(request, "elicitation", "tracker.agent-activity.elicitation.create", result.prompt),
        );
      } else {
        disposition = "response";
        finalWrite = this.api.writeTrackerNarrative(
          this.narrative(request, "response", "tracker.agent-activity.response.create", result.response),
        );
      }
    }

    await Promise.all([acknowledgement, finalWrite]);
    this.emit("handled", event, request.issue.id, disposition);
    return { status: "handled", disposition };
  }

  private toEligibleTrigger(
    event: VerifiedLinearAgentSessionEvent,
  ): EligibleTrigger | { readonly reason: LinearChannelIgnoreReason; readonly issueId?: string } {
    if (event.kind !== "linear.agent-session-event" || event.version !== 1) {
      return { reason: "unsupported_event" };
    }
    const parsed = LinearAgentSessionEventWebhookSchema.safeParse(event.payload);
    if (!parsed.success) return { reason: "unsupported_event" };
    const payload = parsed.data;
    const session = payload.agentSession;
    const issueId = session.issue?.id;

    if (payload.organizationId !== this.identity.workspaceId) {
      return { reason: "app_identity_mismatch", ...(issueId === undefined ? {} : { issueId }) };
    }
    if (payload.appUserId !== this.identity.appUserId || session.appUserId !== this.identity.appUserId) {
      return { reason: "app_identity_mismatch", ...(issueId === undefined ? {} : { issueId }) };
    }
    if (session.organizationId !== this.identity.workspaceId) {
      return { reason: "session_identity_mismatch", ...(issueId === undefined ? {} : { issueId }) };
    }
    if (!session.issue || !session.issueId || session.issue.id !== session.issueId) {
      return { reason: "session_issue_mismatch", ...(issueId === undefined ? {} : { issueId }) };
    }
    if (!session.comment || session.comment.issueId !== session.issue.id) {
      return { reason: "root_comment_issue_mismatch", issueId: session.issue.id };
    }
    if (session.commentId !== session.comment.id) {
      return { reason: "session_identity_mismatch", issueId: session.issue.id };
    }

    let actorId: string;
    let triggerId: string;
    let triggerKind: "activity" | "comment";
    let body: string;
    if (payload.action === "created") {
      if (
        !session.creator ||
        session.creatorId !== session.creator.id ||
        session.creator.id === this.identity.appUserId ||
        session.comment.userId === this.identity.appUserId
      ) {
        return { reason: "non_human_trigger", issueId: session.issue.id };
      }
      actorId = session.creator.id;
      triggerId = session.comment.id;
      triggerKind = "comment";
      body = session.comment.body;
    } else {
      const activity = payload.agentActivity;
      if (
        activity.agentSessionId !== session.id ||
        activity.userId !== activity.user.id ||
        activity.user.id === this.identity.appUserId
      ) {
        return { reason: "non_human_trigger", issueId: session.issue.id };
      }
      actorId = activity.user.id;
      triggerId = activity.id;
      triggerKind = "activity";
      body = activity.content.body;
    }
    if (body.trim().length === 0) return { reason: "unsupported_event", issueId: session.issue.id };

    return {
      request: LinearChannelTurnRequestSchema.parse({
        schemaVersion: 1,
        deliveryId: event.deliveryId,
        action: payload.action,
        identity: { ...this.identity, correlationId: event.correlationId },
        issue: {
          id: session.issue.id,
          identifier: session.issue.identifier,
          url: session.issue.url,
        },
        session: { id: session.id, appUserId: session.appUserId },
        trigger: {
          kind: triggerKind,
          id: triggerId,
          rootCommentId: session.comment.id,
          actorId,
          body: body.trim(),
        },
      }),
    };
  }

  private narrative(
    request: LinearChannelTurnRequest,
    suffix: string,
    action: TrackerNarrativeWrite["action"],
    content: string,
    ephemeral?: boolean,
  ): TrackerNarrativeWrite {
    return {
      schemaVersion: 1,
      idempotencyKey: `${request.deliveryId}:${suffix}`,
      action,
      identity: request.identity,
      issueId: request.issue.id,
      agentSessionId: request.session.id,
      content,
      ...(ephemeral === undefined ? {} : { ephemeral }),
    };
  }

  private approvalRefusal(request: LinearChannelTurnRequest): string {
    const url = new URL(this.approvalSurfaceUrl);
    url.searchParams.set("issueId", request.issue.id);
    url.searchParams.set("agentSessionId", request.session.id);
    return `I can’t grant or execute approvals from Linear. Review this request on the authenticated approval surface: ${url.toString()}`;
  }

  private emit(
    outcome: LinearChannelEvidence["outcome"],
    event: VerifiedLinearAgentSessionEvent,
    issueId?: string,
    reason?: string,
    ackLatencyMs?: number,
  ): void {
    this.evidence({
      service: "linear-channel-adapter",
      outcome,
      timestampMs: this.clock(),
      missionId: this.identity.missionId,
      taskId: this.identity.taskId,
      workerRunId: this.identity.workerRunId,
      correlationId: event.correlationId,
      deliveryId: event.deliveryId,
      ...(issueId === undefined ? {} : { issueId }),
      ...(reason === undefined ? {} : { reason }),
      ...(ackLatencyMs === undefined ? {} : { ackLatencyMs }),
    });
  }

  private pruneDeliveries(): void {
    const now = this.clock();
    for (const [deliveryId, record] of this.deliveries) {
      if (record.expiresAtMs <= now) this.deliveries.delete(deliveryId);
    }
  }
}

interface FixedWindowOptions {
  readonly clock: () => number;
  readonly windowMs: number;
  readonly issueCap: number;
  readonly workspaceCap: number;
}

class FixedWindowLimits {
  private readonly issue = new Map<string, { window: number; count: number }>();
  private readonly workspace = new Map<string, { window: number; count: number }>();
  private readonly options: FixedWindowOptions;
  private activeWindow: number | undefined;

  public constructor(options: FixedWindowOptions) {
    this.options = options;
    for (const [name, value] of [
      ["windowMs", options.windowMs],
      ["issueCap", options.issueCap],
      ["workspaceCap", options.workspaceCap],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    }
  }

  public take(workspaceId: string, issueId: string): "allowed" | "issue_cap" | "workspace_cap" {
    const window = Math.floor(this.options.clock() / this.options.windowMs);
    if (this.activeWindow !== window) {
      this.issue.clear();
      this.workspace.clear();
      this.activeWindow = window;
    }
    const workspace = this.current(this.workspace, workspaceId, window);
    if (workspace.count >= this.options.workspaceCap) return "workspace_cap";
    const issue = this.current(this.issue, `${workspaceId}:${issueId}`, window);
    if (issue.count >= this.options.issueCap) return "issue_cap";
    workspace.count += 1;
    issue.count += 1;
    return "allowed";
  }

  private current(
    entries: Map<string, { window: number; count: number }>,
    key: string,
    window: number,
  ): { window: number; count: number } {
    const existing = entries.get(key);
    if (existing?.window === window) return existing;
    const next = { window, count: 0 };
    entries.set(key, next);
    return next;
  }
}

function isApprovalShaped(content: string): boolean {
  return /\b(approve|approval|authorize|authorization|consent|deploy|merge|publish|release|delete)\b/iu.test(
    content,
  );
}

function assertAuthenticatedSurface(value: string): URL {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Approval surface must use HTTPS or loopback HTTP");
  }
  return url;
}
