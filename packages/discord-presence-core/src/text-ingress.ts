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
  type DiscordVoicePresenceNote,
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
   * How many messages may pass in a channel, after his last reply, before he
   * stops reading it live.
   *
   * Inside this he is mid-conversation and sees each message as it arrives.
   * Past it he has drifted off, exactly as a person does, and the channel piles
   * up unread until he next checks in. `0` means he never reads live.
   */
  readonly liveMessageWindow?: number;
  /** Unread messages retained per channel for a catch-up. Oldest fall off. */
  readonly maxPendingPerChannel?: number;
  /** Channels tracked for catch-up at once. */
  readonly maxTrackedChannels?: number;
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
  /**
   * Set by the bridge when this message asked him into or out of voice and the
   * bridge already executed the decision at its ingress boundary (ADR 0062).
   * Passed through into the turn trigger unchanged so his reply reflects what
   * actually happened.
   */
  readonly voicePresenceNote?: DiscordVoicePresenceNote;
  /** Set only by {@link DiscordTextIngress.catchUp}; he is looking at a backlog. */
  readonly catchingUp?: boolean;
}

export type DiscordTextIngressOutcome =
  | { state: "dropped"; reason: string }
  | { state: "settled"; turnId: string; responseMessageId: string }
  /** Held for the next catch-up: he is not reading this channel right now. */
  | { state: "buffered" }
  /** He read an unprompted message and chose silence. Nothing was written. */
  | { state: "declined"; turnId: string }
  | { state: "waiting_user"; turnId: string; responseMessageId: string }
  | { state: "failed"; code: string };

export interface DiscordTextIngressEvidence {
  readonly service: "discord-text-ingress";
  readonly outcome: "dropped" | "accepted" | "buffered" | "deduplicated" | "settled" | "declined" | "failed";
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
/** Discord shows "typing…" for about ten seconds per post; a turn that thinks longer re-posts to stay visible. */
export const TYPING_REFRESH_MS = 8_000;
/** Roughly how long a conversation stays "the one you are in" before you drift off. */
const DEFAULT_LIVE_MESSAGE_WINDOW = 5;
const DEFAULT_MAX_PENDING_PER_CHANNEL = 20;
const DEFAULT_MAX_TRACKED_CHANNELS = 64;

/**
 * How often he glances at channels that have piled up, by how talkative he is.
 * Mirrors the voice plane's `VOLITION_DEFAULTS` rather than inventing a second
 * notion of chattiness. A tick with no backlog does nothing, so these are an
 * upper bound on attention, not a polling cost.
 */
export const CATCH_UP_INTERVAL_MS: Readonly<Record<"quiet" | "balanced" | "chatty", number>> = {
  quiet: 30 * 60_000,
  balanced: 10 * 60_000,
  chatty: 5 * 60_000,
};

/**
 * A channel he has spoken in, and what has happened there since.
 *
 * Only channels he has actually replied in are tracked. A person checks the
 * rooms they are part of, not every room on the server, and tracking the rest
 * would turn one catch-up tick into a turn per channel.
 */
interface ChannelActivity {
  /** Messages seen since his last reply here. */
  sinceReply: number;
  /** Unread messages awaiting a catch-up, oldest first. */
  readonly pending: DiscordInboundMessage[];
}

/** Normalizes Discord gateway messages into bounded, policy-gated Eve turns. */
export class DiscordTextIngress {
  private readonly deliveries = new Map<string, RetainedDelivery>();
  /** `channelId` -> what has happened there since he last spoke. */
  private readonly channels = new Map<string, ChannelActivity>();
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

    if (!this.readsNow(message)) {
      // He has drifted off this channel. Not dropped and not answered — it
      // waits until he next looks, which is what a person does with a room they
      // are no longer watching.
      const activity = this.channels.get(message.channelId);
      if (activity !== undefined) activity.sinceReply += 1;
      this.buffer(message);
      event("buffered");
      return { state: "buffered" };
    }
    const active = this.channels.get(message.channelId);
    if (active !== undefined) active.sinceReply += 1;

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
        ...(message.voicePresenceNote === undefined ? {} : { voicePresenceNote: message.voicePresenceNote }),
      },
      contextMessages: boundedContext(contextMessages, this.config.contextMessageLimit),
    });
    event("accepted");
    const stopTyping = this.showTyping(message, identity);
    let result: CaptainChannelTurnResult;
    try {
      result = await this.port.submitDiscordCaptainChannelTurn(request);
    } finally {
      // The reply that follows clears the indicator on its own; stopping here
      // just keeps a settled-but-silent turn from showing him typing forever.
      stopTyping();
    }
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
    this.rememberReply(message);
    event("settled", { turnId: result.turnId });
    return {
      state: result.state,
      turnId: result.turnId,
      responseMessageId: reply.messageId,
    };
  }

  /**
   * He is composing an answer to someone who actually asked him, so the
   * channel shows him typing while the turn is in flight — the reply itself
   * then clears the indicator, exactly as it does for a person.
   *
   * Only an addressed message (a DM, a mention, or one of his names) earns
   * this. An unprompted turn is him reading, and a room where he visibly
   * started typing after every message he read — usually followed by silence —
   * would advertise attention he mostly declines to use.
   *
   * The indicator is cosmetic, so it must never delay or fail the turn: posts
   * are fire-and-forget, and the first failure stops the refresh instead of
   * re-hitting a path that is already refusing. Successful posts land in the
   * control plane's narrative ledger like every other presence write.
   */
  private showTyping(message: DiscordInboundMessage, identity: DiscordPresenceWrite["identity"]): () => void {
    if (message.guildId !== undefined && this.unprompted(message)) return () => undefined;
    let sequence = 0;
    const stop = (): void => {
      clearInterval(timer);
    };
    const post = (): void => {
      const write = DiscordPresenceWriteSchema.parse({
        schemaVersion: 1,
        idempotencyKey: `${message.id}:typing:${String(sequence)}`,
        action: "discord.presence.typing_start",
        identity,
        payload: { kind: "typing_start", channelId: message.channelId },
      });
      sequence += 1;
      void this.port.executeDiscordPresenceAction(write).catch(stop);
    };
    const timer = setInterval(post, TYPING_REFRESH_MS);
    timer.unref?.();
    post();
    return stop;
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
      // Whether he is *reading* is decided in `handle`, which can buffer for a
      // later catch-up instead of refusing. Only a channel he has never spoken
      // in refuses outright: a room he was never in is not one he checks.
      if (!addressed && !this.channels.has(message.channelId)) return "not_addressed";
    }
    return undefined;
  }

  /** True when he is being shown this rather than asked to answer it. */
  private unprompted(message: DiscordInboundMessage): boolean {
    return !message.mentionsBot && !addressesCharacter(message.body, this.config.characterNames ?? []);
  }

  /**
   * Look at the channels that have piled up since he last spoke in them.
   *
   * Returns immediately when nothing is waiting, which is the point: an idle
   * server costs nothing at all. A person does not open an empty channel on a
   * timer, and a tick that turned into a model call per tracked channel would
   * bill for silence.
   *
   * Each channel with a backlog gets one turn, never one per message: the most
   * recent unread is the trigger and the rest are its context, so catching up
   * on twenty messages costs the same as catching up on two. He may decline,
   * and declining still clears the backlog — he looked, and deciding there was
   * nothing to say is a real outcome, not a reason to look again.
   */
  public async catchUp(): Promise<readonly DiscordTextIngressOutcome[]> {
    const waiting = [...this.channels.values()].filter((activity) => activity.pending.length > 0);
    if (waiting.length === 0) return [];
    const outcomes: DiscordTextIngressOutcome[] = [];
    for (const activity of waiting) {
      const backlog = [...activity.pending];
      activity.pending.length = 0;
      const trigger = backlog.at(-1);
      if (trigger === undefined) continue;
      outcomes.push(
        await this.handleCatchUp(trigger, backlog.slice(0, -1)).catch((error: unknown) => ({
          state: "failed" as const,
          code: error instanceof Error ? error.name.slice(0, 64) : "catch_up_failed",
        })),
      );
    }
    return outcomes;
  }

  /** One catch-up turn: the newest unread message, carrying the rest as context. */
  private handleCatchUp(
    trigger: DiscordInboundMessage,
    earlier: readonly DiscordInboundMessage[],
  ): Promise<DiscordTextIngressOutcome> {
    return this.handle({
      ...trigger,
      contextMessages: [
        ...earlier.map((message) => ({
          id: message.id,
          authorId: message.authorId,
          body: message.body,
          createdAt: new Date(this.clock()).toISOString(),
        })),
        ...(trigger.contextMessages ?? []),
      ],
      // Reading the backlog *is* him looking, so this must not be buffered
      // again — that would be a channel he can never catch up on.
      catchingUp: true,
    });
  }

  /** Is this one he looks at as it arrives, or one that waits for a catch-up? */
  private readsNow(message: DiscordInboundMessage): boolean {
    // A DM is addressed to him by construction, and `all` means he reads the
    // room by policy. Neither drifts.
    if (message.guildId === undefined) return true;
    if ((this.config.replyPolicy ?? "addressed") === "all") return true;
    if (message.mentionsBot || addressesCharacter(message.body, this.config.characterNames ?? [])) {
      return true;
    }
    return this.readingLive(message);
  }

  /** Is he still mid-conversation here, or has he drifted off? */
  private readingLive(message: DiscordInboundMessage): boolean {
    if (message.catchingUp === true) return true;
    const activity = this.channels.get(message.channelId);
    if (activity === undefined) return false;
    return activity.sinceReply < (this.config.liveMessageWindow ?? DEFAULT_LIVE_MESSAGE_WINDOW);
  }

  /** Records a message he did not read, for the next time he checks in. */
  private buffer(message: DiscordInboundMessage): void {
    const activity = this.channels.get(message.channelId);
    if (activity === undefined) return;
    activity.pending.push(message);
    const cap = this.config.maxPendingPerChannel ?? DEFAULT_MAX_PENDING_PER_CHANNEL;
    // A backlog is what he missed, not an archive: past the cap the oldest go,
    // so checking in on a busy channel reads the recent room rather than
    // replaying an hour of it.
    while (activity.pending.length > cap) activity.pending.shift();
  }

  /**
   * Called once he has actually replied, so a channel becomes one he is in by
   * having spoken there — a turn that failed or was declined leaves him no more
   * present than before.
   */
  private rememberReply(message: DiscordInboundMessage): void {
    const existing = this.channels.get(message.channelId);
    if (existing !== undefined) {
      existing.sinceReply = 0;
      existing.pending.length = 0;
      return;
    }
    const cap = this.config.maxTrackedChannels ?? DEFAULT_MAX_TRACKED_CHANNELS;
    if (this.channels.size >= cap) {
      const oldest = this.channels.keys().next().value;
      if (oldest !== undefined) this.channels.delete(oldest);
    }
    this.channels.set(message.channelId, { sinceReply: 0, pending: [] });
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
