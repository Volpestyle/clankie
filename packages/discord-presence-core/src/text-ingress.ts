import { createHash } from "node:crypto";
import { discordPresenceLaneAddress } from "@clankie/interactive-environment";
import {
  DISCORD_PRESENCE_CONTEXT_MESSAGES_MAX,
  DISCORD_PRESENCE_TRIGGER_BODY_MAX,
  DiscordPresenceChannelTurnRequestSchema,
  DiscordPresenceWriteSchema,
  type CaptainChannelTurnResult,
  type DiscordPresenceChannelTurnRequest,
  type DiscordPresenceWrite,
  type DiscordPresenceWriteResult,
  type DiscordTransportKind,
} from "@clankie/protocol";

export type DiscordDmPolicy = "deny" | "owner_only" | "allowlist";

export interface DiscordTextIngressConfig {
  readonly characterId: string;
  readonly credentialRef: string;
  /** Which body observed the message. Never widens what the turn may do. */
  readonly transportKind: DiscordTransportKind;
  readonly guildIds: ReadonlySet<string>;
  readonly channelIds: ReadonlySet<string>;
  readonly dmPolicy: DiscordDmPolicy;
  readonly ownerUserId?: string;
  readonly dmUserIds: ReadonlySet<string>;
  readonly contextMessageLimit: number;
  readonly authenticatedSurfaceUrl: string;
  /**
   * What earns a reply in an admitted channel. `addressed` (the default)
   * answers a mention or a message that uses one of his names; `all` answers
   * every admitted message.
   *
   * This is evaluated *before* the captain turn on purpose. Deciding to stay
   * quiet must not cost a model call, or an open channel allowlist bills for
   * every message in the server.
   */
  readonly replyPolicy?: DiscordReplyPolicy;
  /** Lowercased names he answers to. Only consulted by the `addressed` policy. */
  readonly characterNames?: readonly string[];
  /**
   * How long someone he has replied to keeps his attention in that channel
   * without using his name again. `0` requires the name every time.
   *
   * There used to be a shorter "reflex" window inside this one, where a reply
   * was compulsory. It bought nothing: both tiers ran the same turn at the same
   * cost, and the only difference was that the inner one took away his choice.
   * A gate decides what reaches him; whether to speak is his on every turn.
   */
  readonly conversationAttentionMs?: number;
  readonly deliveryRetentionMs?: number;
  readonly maxRetainedDeliveries?: number;
}

export type DiscordReplyPolicy = "addressed" | "all";

/** Unknown values fall back to the quiet policy, never the noisy one. */
export function parseDiscordReplyPolicy(value: string | undefined): DiscordReplyPolicy {
  return value?.trim() === "all" ? "all" : "addressed";
}

/**
 * Was he actually spoken to? A bare name match is intentionally generous —
 * humans write "hey clanky", "clankie?", "@Clankie" — but it must not fire on
 * a name embedded in a longer word, or every message mentioning "clankiest"
 * would summon him.
 */
export function addressesCharacter(body: string, names: readonly string[]): boolean {
  if (names.length === 0) return false;
  const haystack = body.toLowerCase();
  return names.some((name) => {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(name, from);
      if (at < 0) return false;
      const before = at === 0 ? "" : haystack[at - 1];
      const after = haystack[at + name.length] ?? "";
      if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
      from = at + 1;
    }
  });
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[a-z0-9]/u.test(value);
}

export interface DiscordInboundContextMessage {
  readonly id: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface DiscordInboundMessage {
  readonly id: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly mentionsBot: boolean;
  readonly body: string;
  readonly contextMessages?: readonly DiscordInboundContextMessage[];
  readonly loadContextMessages?: () => Promise<readonly DiscordInboundContextMessage[]>;
}

export type DiscordTextIngressOutcome =
  | { state: "dropped"; reason: string }
  | { state: "settled"; turnId: string; responseMessageId: string }
  /** He read an unprompted message and chose silence. Nothing was written. */
  | { state: "declined"; turnId: string }
  | { state: "waiting_user"; turnId: string; responseMessageId: string }
  | { state: "failed"; code: string };

export interface DiscordTextIngressEvidence {
  readonly service: "discord-text-ingress";
  readonly outcome: "dropped" | "accepted" | "deduplicated" | "settled" | "declined" | "failed";
  readonly deliveryId: string;
  readonly correlationId: string;
  readonly presenceSessionId: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly actorId: string;
  readonly reason?: string;
  readonly turnId?: string;
}

export interface DiscordTextIngressPort {
  getHealth(): Promise<{ profileHash: string }>;
  submitDiscordCaptainChannelTurn(
    request: DiscordPresenceChannelTurnRequest,
  ): Promise<CaptainChannelTurnResult>;
  executeDiscordPresenceAction(write: DiscordPresenceWrite): Promise<DiscordPresenceWriteResult>;
}

interface RetainedDelivery {
  readonly fingerprint: string;
  readonly result: Promise<DiscordTextIngressOutcome>;
  readonly expiresAtMs: number;
}

const DEFAULT_DELIVERY_RETENTION_MS = 7 * 60 * 60 * 1_000;
const DEFAULT_MAX_RETAINED_DELIVERIES = 50_000;
/** Long enough to cover "sorry, was in a meeting", short enough that yesterday is over. */
const DEFAULT_CONVERSATION_ATTENTION_MS = 6 * 60 * 60 * 1_000;
/** A conversation is one person in one channel; a third party still has to use his name. */
function conversationKey(channelId: string, authorId: string): string {
  return `${channelId}:${authorId}`;
}

/** Normalizes Discord gateway messages into bounded, policy-gated Eve turns. */
export class DiscordTextIngress {
  private readonly deliveries = new Map<string, RetainedDelivery>();
  /** `channel:author` -> when he last replied to them there. */
  private readonly conversations = new Map<string, number>();
  private readonly port: DiscordTextIngressPort;
  private readonly config: DiscordTextIngressConfig;
  private readonly evidence: (event: DiscordTextIngressEvidence) => void;
  private readonly clock: () => number;

  public constructor(
    port: DiscordTextIngressPort,
    config: DiscordTextIngressConfig,
    evidence: (event: DiscordTextIngressEvidence) => void = () => undefined,
    clock: () => number = Date.now,
  ) {
    this.port = port;
    this.config = config;
    this.evidence = evidence;
    this.clock = clock;
    if (
      !Number.isInteger(config.contextMessageLimit) ||
      config.contextMessageLimit < 0 ||
      config.contextMessageLimit > DISCORD_PRESENCE_CONTEXT_MESSAGES_MAX
    ) {
      throw new Error(
        `Discord contextMessageLimit must be between 0 and ${String(DISCORD_PRESENCE_CONTEXT_MESSAGES_MAX)}`,
      );
    }
  }

  public async handle(message: DiscordInboundMessage): Promise<DiscordTextIngressOutcome> {
    const presenceSessionId = presenceSessionIdFor(message);
    const correlationId = `discord-message:${message.id}`;
    const event = (
      outcome: DiscordTextIngressEvidence["outcome"],
      details: Partial<DiscordTextIngressEvidence> = {},
    ) =>
      this.evidence({
        service: "discord-text-ingress",
        outcome,
        deliveryId: message.id,
        correlationId,
        presenceSessionId,
        ...(message.guildId === undefined ? {} : { guildId: message.guildId }),
        channelId: message.channelId,
        actorId: message.authorId,
        ...details,
      });

    const refusal = this.refusalReason(message);
    if (refusal !== undefined) {
      event("dropped", { reason: refusal });
      return { state: "dropped", reason: refusal };
    }

    const body = message.body.trim().slice(0, DISCORD_PRESENCE_TRIGGER_BODY_MAX);
    if (body.length === 0) {
      event("dropped", { reason: "empty_message" });
      return { state: "dropped", reason: "empty_message" };
    }

    this.pruneDeliveries();
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          id: message.id,
          guildId: message.guildId,
          channelId: message.channelId,
          authorId: message.authorId,
          body,
        }),
      )
      .digest("hex");
    const previous = this.deliveries.get(message.id);
    if (previous !== undefined) {
      if (previous.fingerprint !== fingerprint) {
        event("dropped", { reason: "delivery_id_conflict" });
        return { state: "dropped", reason: "delivery_id_conflict" };
      }
      event("deduplicated");
      return previous.result;
    }
    if (this.deliveries.size >= (this.config.maxRetainedDeliveries ?? DEFAULT_MAX_RETAINED_DELIVERIES)) {
      event("dropped", { reason: "delivery_backpressure" });
      return { state: "dropped", reason: "delivery_backpressure" };
    }

    const result = this.runTurn(message, body, presenceSessionId, correlationId, event);
    this.deliveries.set(message.id, {
      fingerprint,
      result,
      expiresAtMs: this.clock() + (this.config.deliveryRetentionMs ?? DEFAULT_DELIVERY_RETENTION_MS),
    });
    try {
      return await result;
    } catch (error) {
      if (this.deliveries.get(message.id)?.result === result) this.deliveries.delete(message.id);
      const code = error instanceof Error ? error.message : "discord_text_ingress_failed";
      event("failed", { reason: code });
      return { state: "failed", code };
    }
  }

  private async runTurn(
    message: DiscordInboundMessage,
    body: string,
    presenceSessionId: string,
    correlationId: string,
    event: (
      outcome: DiscordTextIngressEvidence["outcome"],
      details?: Partial<DiscordTextIngressEvidence>,
    ) => void,
  ): Promise<DiscordTextIngressOutcome> {
    const health = await this.port.getHealth();
    const contextMessages = message.contextMessages ?? (await message.loadContextMessages?.()) ?? [];
    const identity = {
      presenceSessionId,
      correlationId,
      profileHash: health.profileHash,
      characterId: this.config.characterId,
      credentialRef: this.config.credentialRef,
      transportKind: this.config.transportKind,
    };
    const request = DiscordPresenceChannelTurnRequestSchema.parse({
      schemaVersion: 1,
      deliveryId: message.id,
      identity,
      trigger: {
        kind: message.guildId === undefined ? "dm" : message.mentionsBot ? "mention" : "message",
        id: message.id,
        ...(message.guildId === undefined ? {} : { guildId: message.guildId }),
        channelId: message.channelId,
        messageId: message.id,
        actorId: message.authorId,
        body,
        ...(this.unprompted(message) ? { unprompted: true } : {}),
      },
      contextMessages: boundedContext(contextMessages, this.config.contextMessageLimit),
    });
    event("accepted");
    const result = await this.port.submitDiscordCaptainChannelTurn(request);
    if (result.state === "failed") {
      event("failed", {
        reason: result.code,
        ...(result.turnId === undefined ? {} : { turnId: result.turnId }),
      });
      return { state: "failed", code: result.code };
    }

    if (result.state === "silent") {
      // He read it and chose not to answer. Nothing reaches the channel, and
      // the exchange is *not* refreshed: staying quiet is not engagement, so a
      // conversation he has stopped answering ages out instead of holding his
      // attention forever on the strength of declining to use it.
      event("declined", { turnId: result.turnId });
      return { state: "declined", turnId: result.turnId };
    }

    const content = boundedReply(
      result.state === "settled"
        ? result.response
        : result.approvalRequired
          ? `${result.prompt}\n\nDiscord cannot record privileged approval. Continue on ${this.config.authenticatedSurfaceUrl}`
          : result.prompt,
    );
    const write = DiscordPresenceWriteSchema.parse({
      schemaVersion: 1,
      idempotencyKey: `${message.id}:reply`,
      action: "discord.presence.reply",
      identity,
      content,
      payload: {
        kind: "reply",
        channelId: message.channelId,
        messageId: message.id,
        content,
      },
    });
    const reply = await this.port.executeDiscordPresenceAction(write);
    if (!reply.messageId) throw new Error("discord_presence_reply_message_missing");
    this.rememberConversation(message);
    event("settled", { turnId: result.turnId });
    return {
      state: result.state,
      turnId: result.turnId,
      responseMessageId: reply.messageId,
    };
  }

  private refusalReason(message: DiscordInboundMessage): string | undefined {
    if (message.authorIsBot) return "self_or_bot_message";
    if (message.guildId === undefined) {
      if (this.config.dmPolicy === "deny") return "dm_denied";
      if (this.config.dmPolicy === "owner_only" && message.authorId !== this.config.ownerUserId) {
        return "dm_not_owner";
      }
      if (this.config.dmPolicy === "allowlist" && !this.config.dmUserIds.has(message.authorId)) {
        return "dm_not_allowlisted";
      }
      return undefined;
    }
    if (!this.config.guildIds.has(message.guildId)) return "guild_not_allowlisted";
    // The guild allowlist is what bounds ingress to servers the owner chose and
    // is never skipped. The channel list is optional refinement below it: empty
    // admits every channel inside those guilds, matching the voice allowlist so
    // one mental model covers both planes.
    if (this.config.channelIds.size > 0 && !this.config.channelIds.has(message.channelId)) {
      return "channel_not_allowlisted";
    }
    // A DM is already addressed to him by construction; a guild channel is not.
    if ((this.config.replyPolicy ?? "addressed") === "addressed") {
      const addressed =
        message.mentionsBot || addressesCharacter(message.body, this.config.characterNames ?? []);
      // Reaching him and answering him are different questions. This one only
      // decides whether he sees it; he decides the rest, on every turn.
      if (!addressed && !this.holdsAttention(message)) return "not_addressed";
    }
    return undefined;
  }

  /** True when he is being shown this rather than asked to answer it. */
  private unprompted(message: DiscordInboundMessage): boolean {
    return !message.mentionsBot && !addressesCharacter(message.body, this.config.characterNames ?? []);
  }

  /** Whether this person still holds his attention in this channel. */
  private holdsAttention(message: DiscordInboundMessage): boolean {
    const repliedAt = this.conversations.get(conversationKey(message.channelId, message.authorId));
    if (repliedAt === undefined) return false;
    // Strictly less than, so an attention span of `0` disables this outright
    // rather than matching the same millisecond he replied in.
    return (
      this.clock() - repliedAt < (this.config.conversationAttentionMs ?? DEFAULT_CONVERSATION_ATTENTION_MS)
    );
  }

  /**
   * Called once he has actually replied to someone, so attention is earned by a
   * real exchange rather than by merely having been spoken to — a turn that
   * failed or was refused leaves him no more engaged than before.
   */
  private rememberConversation(message: DiscordInboundMessage): void {
    this.conversations.set(conversationKey(message.channelId, message.authorId), this.clock());
  }

  private pruneDeliveries(): void {
    const now = this.clock();
    for (const [deliveryId, delivery] of this.deliveries) {
      if (delivery.expiresAtMs <= now) this.deliveries.delete(deliveryId);
    }
    const attentionMs = this.config.conversationAttentionMs ?? DEFAULT_CONVERSATION_ATTENTION_MS;
    for (const [key, repliedAt] of this.conversations) {
      if (now - repliedAt > attentionMs) this.conversations.delete(key);
    }
  }
}

export function parseDiscordDmPolicy(value: string | undefined): DiscordDmPolicy {
  if (value === undefined || value.trim() === "") return "owner_only";
  if (value === "deny" || value === "owner_only" || value === "allowlist") return value;
  throw new Error("DISCORD_INGRESS_DM_POLICY must be deny, owner_only, or allowlist");
}

export function parseDiscordIdSet(value: string | undefined): ReadonlySet<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function presenceSessionIdFor(message: DiscordInboundMessage): string {
  // Channel-scoped, not transport-scoped: see discordPresenceLaneAddress.
  return discordPresenceLaneAddress(message);
}

function boundedContext(
  messages: readonly DiscordInboundContextMessage[],
  limit: number,
): readonly DiscordInboundContextMessage[] {
  if (limit === 0) return [];
  return messages.slice(-limit).map((message) => ({
    ...message,
    body: message.body.slice(0, DISCORD_PRESENCE_TRIGGER_BODY_MAX),
  }));
}

function boundedReply(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 2_000) return trimmed;
  return `${trimmed.slice(0, 1_997)}…`;
}
