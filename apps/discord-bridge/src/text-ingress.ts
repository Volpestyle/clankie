import { createHash } from "node:crypto";
import {
  DISCORD_PRESENCE_CONTEXT_MESSAGES_MAX,
  DISCORD_PRESENCE_TRIGGER_BODY_MAX,
  DiscordPresenceChannelTurnRequestSchema,
  DiscordPresenceWriteSchema,
  type CaptainChannelTurnResult,
  type DiscordPresenceChannelTurnRequest,
  type DiscordPresenceWrite,
  type DiscordPresenceWriteResult,
} from "@clankie/protocol";

export type DiscordDmPolicy = "deny" | "owner_only" | "allowlist";

export interface DiscordTextIngressConfig {
  readonly characterId: string;
  readonly credentialRef: string;
  readonly guildIds: ReadonlySet<string>;
  readonly channelIds: ReadonlySet<string>;
  readonly dmPolicy: DiscordDmPolicy;
  readonly ownerUserId?: string;
  readonly dmUserIds: ReadonlySet<string>;
  readonly contextMessageLimit: number;
  readonly authenticatedSurfaceUrl: string;
  readonly deliveryRetentionMs?: number;
  readonly maxRetainedDeliveries?: number;
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
  | { state: "waiting_user"; turnId: string; responseMessageId: string }
  | { state: "failed"; code: string };

export interface DiscordTextIngressEvidence {
  readonly service: "discord-text-ingress";
  readonly outcome: "dropped" | "accepted" | "deduplicated" | "settled" | "failed";
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

/** Normalizes Discord gateway messages into bounded, policy-gated Eve turns. */
export class DiscordTextIngress {
  private readonly deliveries = new Map<string, RetainedDelivery>();
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
      transportKind: "bot" as const,
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
    if (!this.config.channelIds.has(message.channelId)) return "channel_not_allowlisted";
    return undefined;
  }

  private pruneDeliveries(): void {
    const now = this.clock();
    for (const [deliveryId, delivery] of this.deliveries) {
      if (delivery.expiresAtMs <= now) this.deliveries.delete(deliveryId);
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
  return `discord:${message.guildId ?? "dm"}:${message.channelId}`;
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
