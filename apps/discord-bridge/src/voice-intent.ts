/**
 * Asked voice presence ([ADR 0062](../../../docs/adr/0062-voice-join-by-asking.md)):
 * a member asking Clankie in text chat — "clankie hop in vc", "clankie you can
 * leave" — moves the official bot into or out of voice like a real server
 * member, with no slash command.
 *
 * The decision lives at the bridge's text ingress boundary, where join
 * authority already lives (ADR 0050): a free mechanical gate, one bounded
 * model call that interprets intent and nothing else, then the same
 * deterministic authority and allowlist checks the slash handlers run. The
 * model never authorizes and never picks a channel — the target is always the
 * asker's current voice channel read from the gateway cache at execution time,
 * so a prompt-injected body cannot steer where he joins. The executed outcome
 * is injected into the same captain turn as a content-free note, so his
 * conversational reply reflects what actually happened.
 *
 * Everything here is injectable and free of the discord.js client, so the
 * whole path is unit-testable offline.
 */

import { addressesCharacter, type JoinDiscordVoiceInput } from "@clankie/discord-presence-core";
import type { DiscordVoicePresenceNote } from "@clankie/protocol";
import {
  authorizeVoicePresenceCommand,
  type DiscordCommandPrincipal,
  type DiscordRoleBindings,
  type DiscordVoiceJoinPolicy,
} from "./authority.ts";
import { createBoundedChatVerdict } from "./voice-composition.ts";

type VoiceAdapterCreator = JoinDiscordVoiceInput["adapterCreator"];

// ---------------------------------------------------------------------------
// The mechanical gate: closed means zero added cost for the message.
// ---------------------------------------------------------------------------

/**
 * Deliberately loose: the gate only decides whether the message is worth one
 * cheap model read, and the decider does the real reading. A false positive
 * costs a bounded call; a false negative costs nothing but a missed
 * convenience.
 */
export const VOICE_PRESENCE_TOKEN_PATTERN = /\b(vc|voice|call|channel|join|hop|come|jump|leave|out|dip)\b/i;

export interface VoicePresenceGateConfig {
  /** The same ingress admission text ingress applies; the gate never widens it. */
  readonly ingressGuildIds: ReadonlySet<string>;
  readonly ingressChannelIds: ReadonlySet<string>;
  /** Lowercased names he answers to — the exact list text ingress consults. */
  readonly characterNames: readonly string[];
}

export interface VoicePresenceGateInput {
  readonly guildId: string | undefined;
  readonly channelId: string;
  readonly authorIsBot: boolean;
  readonly mentionsBot: boolean;
  readonly body: string;
  /** The author's current voice channel per the gateway voice-state cache. */
  readonly authorVoiceChannelId: string | undefined;
}

/**
 * Opens only for an admitted guild message that addresses him (the same
 * `mentionsBot`/`addressesCharacter` test text ingress uses — never a second
 * matcher), whose author is currently sitting in a voice channel of that
 * guild, and whose body carries at least one loose voice-ish token.
 */
export function voicePresenceGateOpen(
  input: VoicePresenceGateInput,
  config: VoicePresenceGateConfig,
): boolean {
  if (input.authorIsBot) return false;
  if (input.guildId === undefined) return false;
  if (!config.ingressGuildIds.has(input.guildId)) return false;
  if (config.ingressChannelIds.size > 0 && !config.ingressChannelIds.has(input.channelId)) return false;
  if (!input.mentionsBot && !addressesCharacter(input.body, config.characterNames)) return false;
  if (input.authorVoiceChannelId === undefined) return false;
  return VOICE_PRESENCE_TOKEN_PATTERN.test(input.body);
}

// ---------------------------------------------------------------------------
// The intent decider: one bounded model read, fails closed to "none".
// ---------------------------------------------------------------------------

export type VoicePresenceIntent = "join" | "leave" | "none";

export const VOICE_PRESENCE_INTENT_SYSTEM_PROMPT =
  "A Discord member who is currently sitting in a voice channel sent Clankie the text message " +
  "that follows. Decide whether it asks Clankie to JOIN the speaker's voice channel, asks " +
  'Clankie to LEAVE voice, or neither. Answer strictly with one word: "join", "leave", or "none".';

/** Discord message bodies cap at 4 000 characters; longer is not a message. */
const INTENT_BODY_MAX_CHARACTERS = 4_000;

export interface VoicePresenceIntentDeciderInput {
  /** The same brokered OpenAI key the realtime ports use. */
  readonly apiKey: string;
  /** `CLANKIE_VOICE_VOLITION_MODEL` — the same cost tier as the volition call. */
  readonly model: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * The bounded intent read. It interprets the message and nothing else —
 * authority and the target channel stay deterministic. Anything other than a
 * clear join or leave, including timeouts, transport errors, and malformed
 * responses, is `"none"` (fail closed). It reads the message body only — never
 * room audio, never transcripts — and the body is never logged.
 */
export function createVoicePresenceIntentDecider(
  input: VoicePresenceIntentDeciderInput,
): (body: string) => Promise<VoicePresenceIntent> {
  const verdict = createBoundedChatVerdict({
    apiKey: input.apiKey,
    model: input.model,
    systemPrompt: VOICE_PRESENCE_INTENT_SYSTEM_PROMPT,
    maxUserTextCharacters: INTENT_BODY_MAX_CHARACTERS,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  return async (body) => {
    const answer = await verdict(body);
    return answer === "join" || answer === "leave" ? answer : "none";
  };
}

// ---------------------------------------------------------------------------
// Execution: the slash handlers' authority, reused, never duplicated.
// ---------------------------------------------------------------------------

/** The slice of the media-owning voice session an asked decision needs. */
export interface VoicePresenceSessionPort {
  status(): { readonly active: boolean; readonly guildId?: string; readonly channelId?: string };
  join(input: {
    readonly guildId: string;
    readonly channelId: string;
    readonly adapterCreator: VoiceAdapterCreator;
  }): Promise<unknown>;
  leave(): Promise<void>;
}

export interface VoicePresenceExecutionConfig {
  readonly bindings: DiscordRoleBindings;
  /** The ADR 0050 voice presence tier — identical to `/clankie join` and `/clankie leave`. */
  readonly joinPolicy: DiscordVoiceJoinPolicy;
  /** The voice allowlists (ADR 0045): guilds required, channels optional refinement. */
  readonly voiceGuildIds: ReadonlySet<string>;
  readonly voiceChannelIds: ReadonlySet<string>;
  readonly voiceSession: VoicePresenceSessionPort | undefined;
}

export interface VoicePresenceExecutionInput {
  readonly intent: "join" | "leave";
  readonly guildId: string;
  readonly principal: DiscordCommandPrincipal;
  /** The asker's channel at execution time, from the gateway cache — never from the model. */
  readonly memberVoiceChannelId: string | undefined;
  readonly adapterCreator: VoiceAdapterCreator;
}

/**
 * Deterministic execution under exactly the slash tier: the ADR 0050 voice
 * presence authority, the voice guild/channel allowlists, and the slash
 * `leave` cross-guild bound. Refusals never throw — they become the
 * content-free note the captain turn carries.
 */
export async function executeVoicePresenceIntent(
  config: VoicePresenceExecutionConfig,
  input: VoicePresenceExecutionInput,
): Promise<DiscordVoicePresenceNote> {
  const refused = input.intent === "join" ? ("join_refused" as const) : ("leave_refused" as const);
  const authority = authorizeVoicePresenceCommand(input.principal, config.bindings, config.joinPolicy);
  if (!authority.allowed) return { action: refused, reason: "authority" };
  const session = config.voiceSession;
  if (session === undefined) return { action: refused, reason: "voice_disabled" };
  if (input.intent === "leave") {
    // The same bound as slash leave: an open join policy in one allowlisted
    // guild must not hang up a call happening in another.
    const active = session.status();
    if (active.active && active.guildId !== input.guildId) {
      return { action: "leave_refused", reason: "other_guild" };
    }
    const channelId = active.active ? active.channelId : undefined;
    try {
      await session.leave();
    } catch {
      return { action: "leave_refused", reason: "failed" };
    }
    return { action: "left", ...(channelId === undefined ? {} : { channelId }) };
  }
  const channelId = input.memberVoiceChannelId;
  if (channelId === undefined) return { action: "join_refused", reason: "not_in_voice" };
  // An empty channel allowlist admits every voice channel in an allowlisted
  // guild; the guild check is never skipped (same rule as slash join).
  const channelAllowed = config.voiceChannelIds.size === 0 || config.voiceChannelIds.has(channelId);
  if (!config.voiceGuildIds.has(input.guildId) || !channelAllowed) {
    return { action: "join_refused", reason: "allowlist" };
  }
  const active = session.status();
  if (active.active && active.guildId !== input.guildId) {
    return { action: "join_refused", reason: "other_guild" };
  }
  if (active.active && active.guildId === input.guildId && active.channelId === channelId) {
    // Already sitting exactly where he was asked. Joining again would tear the
    // session down and reopen the consent registry, silently un-consenting
    // everyone who opted in — being there already is success, never a rejoin.
    return { action: "joined", channelId };
  }
  try {
    await session.join({ guildId: input.guildId, channelId, adapterCreator: input.adapterCreator });
  } catch {
    return { action: "join_refused", reason: "failed" };
  }
  return { action: "joined", channelId };
}

// ---------------------------------------------------------------------------
// The composed path the message handler calls.
// ---------------------------------------------------------------------------

/** The asker as the gateway cache sees them right now. */
export interface VoicePresenceMember {
  readonly roleIds: ReadonlySet<string>;
  readonly voiceChannelId: string | undefined;
  readonly adapterCreator: VoiceAdapterCreator;
}

export interface VoicePresenceAskOptions {
  readonly gate: VoicePresenceGateConfig;
  readonly decider: (body: string) => Promise<VoicePresenceIntent>;
  readonly execution: VoicePresenceExecutionConfig;
}

export interface VoicePresenceAskMessage {
  readonly guildId?: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly mentionsBot: boolean;
  readonly body: string;
}

/**
 * The whole asked-presence path for one inbound message: mechanical gate →
 * bounded intent read → deterministic execution. Returns the note to inject
 * into the same captain turn, or `undefined` when the gate stayed closed or
 * the decider read no ask — the normal turn proceeds untouched either way.
 *
 * `resolveMember` reads the asker from the gateway cache and is consulted
 * twice: once for the gate (is the asker in voice at all?) and again at
 * execution time, so he joins where the asker is *now*, not where they were
 * when the message arrived — and never anywhere the model output says.
 */
export async function handleVoicePresenceAsk(
  options: VoicePresenceAskOptions,
  message: VoicePresenceAskMessage,
  resolveMember: () => VoicePresenceMember | undefined,
): Promise<DiscordVoicePresenceNote | undefined> {
  const guildId = message.guildId;
  if (guildId === undefined || message.authorIsBot) return undefined;
  const member = resolveMember();
  if (member === undefined) return undefined;
  const open = voicePresenceGateOpen(
    {
      guildId,
      channelId: message.channelId,
      authorIsBot: message.authorIsBot,
      mentionsBot: message.mentionsBot,
      body: message.body,
      authorVoiceChannelId: member.voiceChannelId,
    },
    options.gate,
  );
  if (!open) return undefined;
  const intent = await options.decider(message.body);
  if (intent === "none") return undefined;
  // A fresh read: the asker may have moved (or left voice) while the decider
  // ran, and a stale channel must never be joined.
  const current = resolveMember();
  return executeVoicePresenceIntent(options.execution, {
    intent,
    guildId,
    principal: { userId: message.authorId, roleIds: (current ?? member).roleIds },
    memberVoiceChannelId: current?.voiceChannelId,
    adapterCreator: (current ?? member).adapterCreator,
  });
}
