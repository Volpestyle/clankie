import { randomUUID } from "node:crypto";
import type { ClankieApiClient } from "@clankie/api-client";
import {
  SLACK_TRIGGER_BODY_MAX,
  SlackChannelTurnRequestSchema,
  type CaptainChannelTurnResult,
  type SlackChannelTurnRequest,
  type SlackTriggerKind,
} from "@clankie/protocol";
import type { SlackEventCallback } from "../../relay/src/slack-webhook-protocol.ts";

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_CHANNEL_CAP = 20;
const DEFAULT_TEAM_CAP = 100;
const DEFAULT_MAX_RETAINED_DELIVERIES = 50_000;
const DELIVERY_RETENTION_MS = 7 * 60 * 60 * 1_000;

export interface SlackChannelApi {
  submitSlackCaptainChannelTurn(input: SlackChannelTurnRequest): Promise<CaptainChannelTurnResult>;
}

export interface SlackChannelAdapterIdentity {
  readonly profileHash: string;
  /** The bot user id this installation authenticates as. */
  readonly appUserId: string;
}

/** Posts Clankie's reply back into the originating thread. */
export interface SlackReplyTransport {
  postMessage(input: { channelId: string; threadTs: string; text: string }): Promise<void>;
}

export type SlackChannelDisposition = "response" | "elicitation" | "approval_requested" | "failed" | "silent";

export type SlackChannelOutcome =
  | { readonly status: "handled"; readonly disposition: SlackChannelDisposition }
  | { readonly status: "ignored"; readonly reason: SlackChannelIgnoreReason };

export type SlackChannelIgnoreReason =
  | "app_identity_mismatch"
  | "bot_message"
  | "channel_cap"
  | "duplicate_delivery"
  | "empty_body"
  | "not_addressed"
  | "self_message"
  | "team_cap"
  | "unsupported_event";

export interface SlackChannelEvidence {
  readonly service: "slack-channel-adapter";
  readonly outcome: "captain_submitted" | "handled" | "ignored" | "reply_failed";
  readonly timestampMs: number;
  readonly correlationId: string;
  readonly eventId: string;
  readonly teamId: string;
  readonly reason?: string;
}

export type SlackChannelEvidenceSink = (evidence: SlackChannelEvidence) => void;

export interface SlackChannelAdapterOptions {
  readonly api: SlackChannelApi | ClankieApiClient;
  readonly identity: SlackChannelAdapterIdentity;
  readonly reply: SlackReplyTransport;
  readonly approvalSurfaceUrl: string;
  readonly clock?: () => number;
  readonly windowMs?: number;
  readonly maxEventsPerChannel?: number;
  readonly maxEventsPerTeam?: number;
  readonly maxRetainedDeliveries?: number;
  readonly evidence?: SlackChannelEvidenceSink;
  readonly deliveryIdFactory?: () => string;
}

/**
 * Turns a verified Slack event into one captain turn (ADR 0080).
 *
 * The adapter owns judgment — dedupe, caps, addressing, and the reply — and
 * owns none of the meaning: what an instruction *is* stays behind the captain
 * boundary, so this file never plans, routes, or decides.
 */
export class SlackChannelAdapter {
  private readonly options: SlackChannelAdapterOptions;
  private readonly clock: () => number;
  private readonly seenEventIds = new Map<string, number>();
  private readonly channelWindow = new Map<string, number[]>();
  private readonly teamWindow = new Map<string, number[]>();

  public constructor(options: SlackChannelAdapterOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => Date.now());
  }

  public async handle(event: SlackEventCallback): Promise<SlackChannelOutcome> {
    const now = this.clock();
    const eventId = event.event_id;
    const teamId = event.team_id;
    const correlationId = `slack-event:${eventId}`;
    const ignore = (reason: SlackChannelIgnoreReason): SlackChannelOutcome => {
      this.emit({
        service: "slack-channel-adapter",
        outcome: "ignored",
        timestampMs: now,
        correlationId,
        eventId,
        teamId,
        reason,
      });
      return { status: "ignored", reason };
    };

    this.prune(now);
    if (this.seenEventIds.has(eventId)) return ignore("duplicate_delivery");

    // Slack authorizes each delivery to a specific installed bot user. An event
    // authorized for another app is not ours to answer.
    const authorized = event.authorizations?.some(
      (entry) => entry.user_id === this.options.identity.appUserId,
    );
    if (event.authorizations !== undefined && authorized !== true) {
      return ignore("app_identity_mismatch");
    }

    const inner = event.event;
    // A bot's own words must never become a turn: two bots in one channel would
    // otherwise answer each other forever.
    if (inner.bot_id !== undefined) return ignore("bot_message");
    if (inner.user === undefined) return ignore("unsupported_event");
    if (inner.user === this.options.identity.appUserId) return ignore("self_message");
    // Edits, deletions, joins, and file-share subtypes are channel noise, not
    // someone speaking to him.
    if (inner.subtype !== undefined) return ignore("unsupported_event");

    const kind = this.triggerKind(inner);
    if (kind === undefined) return ignore("not_addressed");

    const body = (inner.text ?? "").trim().slice(0, SLACK_TRIGGER_BODY_MAX);
    if (body.length === 0) return ignore("empty_body");

    const threadTs = inner.thread_ts ?? inner.ts;
    if (!this.admit(this.channelWindow, inner.channel, now, this.channelCap())) {
      return ignore("channel_cap");
    }
    if (!this.admit(this.teamWindow, teamId, now, this.teamCap())) return ignore("team_cap");
    this.seenEventIds.set(eventId, now);

    const request = SlackChannelTurnRequestSchema.parse({
      schemaVersion: 1,
      deliveryId: (this.options.deliveryIdFactory ?? randomUUID)(),
      identity: {
        correlationId,
        profileHash: this.options.identity.profileHash,
        teamId,
        appUserId: this.options.identity.appUserId,
      },
      conversation: {
        channelId: inner.channel,
        threadTs,
        isDirectMessage: kind === "direct_message",
      },
      trigger: { kind, eventId, messageTs: inner.ts, actorId: inner.user, body },
    } satisfies SlackChannelTurnRequest);

    this.emit({
      service: "slack-channel-adapter",
      outcome: "captain_submitted",
      timestampMs: this.clock(),
      correlationId,
      eventId,
      teamId,
    });
    const result = await this.options.api.submitSlackCaptainChannelTurn(request);
    const disposition = await this.deliver(result, inner.channel, threadTs, correlationId, eventId, teamId);
    this.emit({
      service: "slack-channel-adapter",
      outcome: "handled",
      timestampMs: this.clock(),
      correlationId,
      eventId,
      teamId,
      reason: disposition,
    });
    return { status: "handled", disposition };
  }

  private async deliver(
    result: CaptainChannelTurnResult,
    channelId: string,
    threadTs: string,
    correlationId: string,
    eventId: string,
    teamId: string,
  ): Promise<SlackChannelDisposition> {
    const reply = this.replyFor(result);
    if (reply === undefined) return "silent";
    try {
      await this.options.reply.postMessage({ channelId, threadTs, text: reply.text });
    } catch {
      this.emit({
        service: "slack-channel-adapter",
        outcome: "reply_failed",
        timestampMs: this.clock(),
        correlationId,
        eventId,
        teamId,
      });
    }
    return reply.disposition;
  }

  /**
   * An approval request never becomes a Slack button or a yes/no reply: the
   * thread gets a link to the authenticated approval surface, because no
   * channel lane may widen approval authority (ADR 0080).
   *
   * A failure answers in the thread too. Staying silent would be
   * indistinguishable from being ignored, and the person who asked deserves to
   * know nothing happened — without the raw error code, which is diagnostic
   * detail rather than something a channel should carry.
   */
  private replyFor(
    result: CaptainChannelTurnResult,
  ): { text: string; disposition: SlackChannelDisposition } | undefined {
    switch (result.state) {
      case "settled":
        return { text: result.response, disposition: "response" };
      case "silent":
        return undefined;
      case "waiting_user":
        return result.approvalRequired
          ? {
              text: `${result.prompt}\n\nThat needs your approval before I can act — ${this.options.approvalSurfaceUrl}`,
              disposition: "approval_requested",
            }
          : { text: result.prompt, disposition: "elicitation" };
      case "failed":
        return {
          text: "Something went wrong on my end and I did not act on that.",
          disposition: "failed",
        };
    }
  }

  /**
   * A mention is always addressed. A plain message counts only inside a thread
   * or a DM, so an ordinary channel conversation between humans never reaches
   * the model.
   */
  private triggerKind(inner: SlackEventCallback["event"]): SlackTriggerKind | undefined {
    if (inner.type === "app_mention") return "app_mention";
    if (inner.channel_type === "im") return "direct_message";
    if (inner.thread_ts !== undefined) return "thread_reply";
    return undefined;
  }

  private admit(window: Map<string, number[]>, key: string, now: number, cap: number): boolean {
    const windowMs = this.options.windowMs ?? DEFAULT_WINDOW_MS;
    const entries = (window.get(key) ?? []).filter((stamp) => now - stamp < windowMs);
    if (entries.length >= cap) {
      window.set(key, entries);
      return false;
    }
    entries.push(now);
    window.set(key, entries);
    return true;
  }

  private prune(now: number): void {
    const max = this.options.maxRetainedDeliveries ?? DEFAULT_MAX_RETAINED_DELIVERIES;
    for (const [eventId, stamp] of this.seenEventIds) {
      if (now - stamp > DELIVERY_RETENTION_MS) this.seenEventIds.delete(eventId);
    }
    // Bounded even if retention alone would not shrink it: oldest first, so a
    // burst can never grow the dedupe set without limit.
    if (this.seenEventIds.size > max) {
      const excess = this.seenEventIds.size - max;
      let removed = 0;
      for (const eventId of this.seenEventIds.keys()) {
        if (removed >= excess) break;
        this.seenEventIds.delete(eventId);
        removed += 1;
      }
    }
  }

  private channelCap(): number {
    return this.options.maxEventsPerChannel ?? DEFAULT_CHANNEL_CAP;
  }

  private teamCap(): number {
    return this.options.maxEventsPerTeam ?? DEFAULT_TEAM_CAP;
  }

  private emit(evidence: SlackChannelEvidence): void {
    this.options.evidence?.(evidence);
  }
}
