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
 * gate reads "spoken to" the way text ingress does — an explicit mention/name
 * or a message inside a conversation he is actively answering — so a natural
 * follow-up ("hop in vc and play") counts. A message that names him explicitly
 * needs no voice-ish word when the asker is already standing in a voice
 * channel — "clankie i wanna talk to you" from inside vc is an ask in every
 * sense that matters. The model never authorizes and
 * never picks a channel — the target is always the asker's current voice
 * channel read from the gateway cache at execution time, so a prompt-injected
 * body cannot steer where he joins. The executed outcome is injected into the
 * same captain turn as a content-free note, so his conversational reply
 * reflects what actually happened — including the honest refusal when the
 * asker is not in a voice channel yet.
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
  /**
   * Text ingress's own mid-conversation verdict for this channel
   * (`DiscordTextIngress.engagedInChannel`), read before this message is
   * handled. A follow-up inside a conversation he is already answering is
   * addressed to him in every sense that matters — requiring his name on each
   * message made "hop in vc and play" silently miss right after he replied.
   */
  readonly engagedInChannel: boolean;
  /**
   * The asker's gateway voice-state presence, read before the gate. Standing
   * in a voice channel while naming him explicitly substitutes for a voice-ish
   * word — see {@link voicePresenceGateOpen}.
   */
  readonly askerInVoice: boolean;
}

/**
 * Opens only for an admitted guild message that speaks to him — the same
 * notion text ingress reads with, never a second matcher: an explicit
 * mention/name, or a message inside a conversation he is actively answering —
 * whose body carries at least one loose voice-ish token, or names him
 * explicitly while the asker stands in a voice channel.
 *
 * The asker's voice state never closes the gate: execution owns voice state,
 * so a worded ask from outside voice earns the honest
 * `join_refused: not_in_voice` note (which his reply can speak to — "hop in a
 * channel and ask again") instead of a silent shrug, and a leave ask needs no
 * voice presence from the asker at all. Voice state only opens the gate wider:
 * a wordless message that names him explicitly, from an asker already in
 * voice, is worth the read — a live trace showed "clankie i wanna talk to
 * you" from inside vc exiting unread, and the asker's gateway voice-state is
 * a stronger ask signal than any word list. The engaged-conversation door
 * keeps requiring a token word: an engaged channel chats freely while members
 * sit in voice, and a read per message is the cost the word-gate exists to
 * avoid.
 *
 * `handleVoicePresenceAsk` inlines these same checks in the same order rather
 * than calling this, so each stage's outcome can land in the trace; this
 * function remains the gate's pure specification and is what the tests pin.
 * A semantic change here must be mirrored there.
 */
export function voicePresenceGateOpen(
  input: VoicePresenceGateInput,
  config: VoicePresenceGateConfig,
): boolean {
  if (input.authorIsBot) return false;
  if (input.guildId === undefined) return false;
  if (!config.ingressGuildIds.has(input.guildId)) return false;
  if (config.ingressChannelIds.size > 0 && !config.ingressChannelIds.has(input.channelId)) return false;
  if (
    !input.mentionsBot &&
    !addressesCharacter(input.body, config.characterNames) &&
    !input.engagedInChannel
  ) {
    return false;
  }
  if (VOICE_PRESENCE_TOKEN_PATTERN.test(input.body)) return true;
  return (input.mentionsBot || addressesCharacter(input.body, config.characterNames)) && input.askerInVoice;
}

// ---------------------------------------------------------------------------
// The intent decider: one bounded model read, fails closed to "none".
// ---------------------------------------------------------------------------

export type VoicePresenceIntent = "join" | "leave" | "none";

export const VOICE_PRESENCE_INTENT_SYSTEM_PROMPT =
  "A Discord member sent Clankie the text message that follows, possibly as a follow-up in an " +
  "ongoing conversation. Decide whether it asks Clankie to JOIN the sender's voice channel, asks " +
  "Clankie to LEAVE voice, or neither. Earlier channel messages may precede it for context only — " +
  "judge the final message alone, and only what it asks of Clankie: a request aimed at another " +
  'member is "none". Answer strictly with one word: "join", "leave", or "none".';

/** Discord message bodies cap at 4 000 characters; longer is not a message. */
const INTENT_BODY_MAX_CHARACTERS = 4_000;
/** Context is for disambiguation, not history: the last few lines, tightly cut. */
const INTENT_CONTEXT_MAX_LINES = 6;
const INTENT_CONTEXT_LINE_MAX_CHARACTERS = 400;
/** Body cap plus the bounded context lines; the judged message is never the part cut. */
const INTENT_TEXT_MAX_CHARACTERS =
  INTENT_BODY_MAX_CHARACTERS + INTENT_CONTEXT_MAX_LINES * (INTENT_CONTEXT_LINE_MAX_CHARACTERS + 32) + 128;

/**
 * One recent channel line for the decider, attributed by role only. Bodies go
 * to the model and nowhere else — same discipline as the ask body itself.
 */
export interface VoicePresenceContextLine {
  readonly speaker: "clankie" | "asker" | "other";
  readonly body: string;
}

/** What the decider reads: the ask body plus bounded recent lines, oldest first. */
export interface VoicePresenceAsk {
  readonly body: string;
  readonly context: readonly VoicePresenceContextLine[];
}

const SPEAKER_LABELS: Readonly<Record<VoicePresenceContextLine["speaker"], string>> = {
  clankie: "Clankie",
  asker: "the sender",
  other: "another member",
};

/** The exact user text a decider read sends; exported so the tests pin it. */
export function renderVoicePresenceAskText(ask: VoicePresenceAsk): string {
  const body = ask.body.slice(0, INTENT_BODY_MAX_CHARACTERS);
  if (ask.context.length === 0) return body;
  const lines = ask.context
    .slice(-INTENT_CONTEXT_MAX_LINES)
    .map(
      (line) => `[${SPEAKER_LABELS[line.speaker]}] ${line.body.slice(0, INTENT_CONTEXT_LINE_MAX_CHARACTERS)}`,
    );
  return `Earlier channel messages, oldest first:\n${lines.join("\n")}\n\nThe message to judge, from the sender:\n${body}`;
}

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
 * responses, is `"none"` (fail closed). It reads the message body plus a few
 * bounded recent channel lines — never room audio, never transcripts — and
 * none of that text is ever logged. Context earns its place because natural
 * addressing means the ask body often names nobody ("get in here"): without
 * the surrounding lines the decider cannot tell an ask to Clankie from an ask
 * to another member.
 */
export function createVoicePresenceIntentDecider(
  input: VoicePresenceIntentDeciderInput,
): (ask: VoicePresenceAsk) => Promise<VoicePresenceIntent> {
  const verdict = createBoundedChatVerdict({
    apiKey: input.apiKey,
    model: input.model,
    systemPrompt: VOICE_PRESENCE_INTENT_SYSTEM_PROMPT,
    maxUserTextCharacters: INTENT_TEXT_MAX_CHARACTERS,
    ...(input.baseUrl === undefined ? {} : { baseUrl: input.baseUrl }),
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  return async (ask) => {
    const answer = await verdict(renderVoicePresenceAskText(ask));
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
  readonly decider: (ask: VoicePresenceAsk) => Promise<VoicePresenceIntent>;
  readonly execution: VoicePresenceExecutionConfig;
  /**
   * One content-free trace per message that speaks to him (never the body),
   * emitted whether or not anything executed. Such messages are rare enough to
   * log every evaluation, and a silent early exit here already cost one live
   * debugging session — "he said he can't" with no record of which stage
   * declined is exactly the inference-from-output doctrine forbids.
   */
  readonly onTrace?: (trace: VoicePresenceAskTrace) => void;
}

export interface VoicePresenceAskTrace {
  readonly deliveryId: string;
  /** Which door opened: his name/mention, or the conversation he was already in. */
  readonly addressed: boolean;
  readonly engaged: boolean;
  readonly memberResolved: boolean;
  /** The asker's gateway voice-state presence at gate time. */
  readonly inVoice: boolean;
  readonly voiceToken: boolean;
  /** Absent when the gate stayed closed. */
  readonly intent?: VoicePresenceIntent;
  /** Present when execution ran. */
  readonly action?: DiscordVoicePresenceNote["action"];
  readonly reason?: DiscordVoicePresenceNote["reason"];
}

export interface VoicePresenceAskMessage {
  readonly id: string;
  readonly guildId?: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly authorIsBot: boolean;
  readonly mentionsBot: boolean;
  readonly body: string;
  /** Text ingress's mid-conversation verdict for this channel — see {@link VoicePresenceGateInput}. */
  readonly engagedInChannel: boolean;
  /**
   * Recent channel lines for the decider, loaded only if the gate opens — a
   * closed gate must stay free. A failed load degrades to a body-only read
   * rather than dropping the ask.
   */
  readonly loadContext?: () => Promise<readonly VoicePresenceContextLine[]>;
}

/**
 * The whole asked-presence path for one inbound message: mechanical gate →
 * bounded intent read → deterministic execution. Returns the note to inject
 * into the same captain turn, or `undefined` when the gate stayed closed or
 * the decider read no ask — the normal turn proceeds untouched either way.
 *
 * `resolveMember` reads the asker from the gateway cache and is consulted
 * twice: once for the principal the gate needs, and again at execution time,
 * so he joins where the asker is *now*, not where they were when the message
 * arrived — and never anywhere the model output says.
 */
export async function handleVoicePresenceAsk(
  options: VoicePresenceAskOptions,
  message: VoicePresenceAskMessage,
  resolveMember: () => VoicePresenceMember | undefined,
): Promise<DiscordVoicePresenceNote | undefined> {
  const guildId = message.guildId;
  if (guildId === undefined || message.authorIsBot) return undefined;
  if (!options.gate.ingressGuildIds.has(guildId)) return undefined;
  if (options.gate.ingressChannelIds.size > 0 && !options.gate.ingressChannelIds.has(message.channelId)) {
    return undefined;
  }
  const addressed = message.mentionsBot || addressesCharacter(message.body, options.gate.characterNames);
  // Messages that speak to nobody he answers exit before tracing — they are
  // the common case and a trace per guild message is log spam, not
  // observability.
  if (!addressed && !message.engagedInChannel) return undefined;
  const member = resolveMember();
  const voiceToken = VOICE_PRESENCE_TOKEN_PATTERN.test(message.body);
  const trace = (extra: Partial<VoicePresenceAskTrace> = {}): void => {
    options.onTrace?.({
      deliveryId: message.id,
      addressed,
      engaged: message.engagedInChannel,
      memberResolved: member !== undefined,
      inVoice: member?.voiceChannelId !== undefined,
      voiceToken,
      ...extra,
    });
  };
  // An unresolvable member (the restart-shaped blind spot) leaves no principal
  // to execute under, so the read would be wasted. The asker being out of
  // voice is NOT an exit: execution answers that with an honest note. A
  // wordless message opens only through the second door — named explicitly by
  // an asker already standing in voice.
  if (member === undefined || (!voiceToken && !(addressed && member.voiceChannelId !== undefined))) {
    trace();
    return undefined;
  }
  let context: readonly VoicePresenceContextLine[] = [];
  if (message.loadContext !== undefined) {
    try {
      context = await message.loadContext();
    } catch {
      // Body-only is a degraded read, not a dropped ask.
    }
  }
  const intent = await options.decider({ body: message.body, context });
  if (intent === "none") {
    trace({ intent });
    return undefined;
  }
  // A fresh read: the asker may have moved (or left voice) while the decider
  // ran, and a stale channel must never be joined.
  const current = resolveMember();
  const note = await executeVoicePresenceIntent(options.execution, {
    intent,
    guildId,
    principal: { userId: message.authorId, roleIds: (current ?? member).roleIds },
    memberVoiceChannelId: current?.voiceChannelId,
    adapterCreator: (current ?? member).adapterCreator,
  });
  trace({ intent, action: note.action, ...(note.reason === undefined ? {} : { reason: note.reason }) });
  return note;
}
