// Turn-taking for a channel (ADR 0146).
//
// A channel has no reply policy: every member reads the shared transcript and
// decides for itself whether to answer, add something, or stay quiet. That
// judgement is only possible if members are offered turns in sequence — members
// prompted simultaneously cannot see each other, so they would all answer at
// once, every time.
//
// This module owns the sequence and nothing else. It never decides what a
// member says, only who is offered the next chance to say it.

import type { OperatorChannelMember } from "@clankie/protocol";

/** One member's outcome on the turn it was offered. */
type ChannelTurnOutcome = "spoke" | "passed";

export interface ChannelTurnRecord {
  readonly personaId: string;
  readonly outcome: ChannelTurnOutcome;
}

export interface ChannelTurnState {
  /** Members, in the order they are offered turns. */
  readonly members: readonly OperatorChannelMember[];
  /** Outcomes so far for the message currently being answered. */
  readonly taken: readonly ChannelTurnRecord[];
  /**
   * Seats that have posted since the operator last spoke, including any that
   * started the exchange. A member never answers its own message.
   */
  readonly lastSpeakerPersonaId?: string;
}

/**
 * Who is offered the next turn, or `undefined` when the round is over.
 *
 * Every member gets at most one turn per operator message. That bound is the
 * whole reason agents cannot talk each other into an infinite exchange: without
 * it, two members that each find the other worth replying to would trade
 * messages until something ran out of money. A member with more to say waits for
 * the operator, exactly as a person in a group DM does.
 */
export function nextChannelTurn(state: ChannelTurnState): OperatorChannelMember | undefined {
  const done = new Set(state.taken.map((record) => record.personaId));
  return [...state.members]
    .sort(
      (first, second) => first.position - second.position || first.personaId.localeCompare(second.personaId),
    )
    .find((member) => !done.has(member.personaId) && member.personaId !== state.lastSpeakerPersonaId);
}

/**
 * Whether the round has anything left to offer. A round ends when every member
 * has had its turn, not when someone answers: a second member may have
 * something worth adding, and in a real room it would say so.
 */
export function channelRoundComplete(state: ChannelTurnState): boolean {
  return nextChannelTurn(state) === undefined;
}

/**
 * What a member is shown when its turn comes: the transcript as it stands right
 * now, including anything a member earlier in the order just said. Passing that
 * along is what lets a member see its point already made and stay quiet.
 */
export interface ChannelTurnPrompt {
  readonly personaId: string;
  /** Members who already spoke on this message, in the order they spoke. */
  readonly spokeBefore: readonly string[];
  /** True when nobody has answered yet, so this member is first to respond. */
  readonly firstResponder: boolean;
}

export function channelTurnPrompt(state: ChannelTurnState, member: OperatorChannelMember): ChannelTurnPrompt {
  const spokeBefore = state.taken
    .filter((record) => record.outcome === "spoke")
    .map((record) => record.personaId);
  return {
    personaId: member.personaId,
    spokeBefore,
    firstResponder: spokeBefore.length === 0,
  };
}

/**
 * The per-message cost of a round, in model calls, before anyone is asked.
 * Sequential turn-taking charges for every member whether it speaks or passes,
 * which is the known price of the emergent behaviour and the reason membership
 * is bounded (ADR 0146).
 */
export function channelRoundCost(state: ChannelTurnState): number {
  return state.members.filter((member) => member.personaId !== state.lastSpeakerPersonaId).length;
}

/**
 * What a member answers with when it has nothing to add. Passing has to be
 * something the member can say in the same breath as an answer, because the
 * decision is the member's and is made in one turn — there is no second channel
 * to signal on. A pass is matched exactly and is never written to the
 * transcript, so a room full of passes stays silent.
 */
const CHANNEL_TURN_PASS = "PASS";

export function isChannelTurnPass(reply: string): boolean {
  return reply.trim().toUpperCase() === CHANNEL_TURN_PASS;
}

/**
 * What the room actually hears from one member, or undefined when it says
 * nothing.
 *
 * The exact match above is right and stays: `PASS — but check the decode path`
 * is a member making a point, and swallowing it would lose the point. What it
 * does not cover is a member that writes `PASS` on its own line and then keeps
 * talking — a mind changed mid-reply. That published the sentinel and the
 * deliberation behind it straight into Discord on 2026-08-30. Take the words,
 * drop the line: nothing is swallowed and the sentinel never ships.
 */
export function channelTurnReply(reply: string | undefined): string | undefined {
  if (reply === undefined) return undefined;
  const trimmed = reply.trim();
  if (trimmed.length === 0 || isChannelTurnPass(trimmed)) return undefined;
  const breakAt = trimmed.indexOf("\n");
  if (breakAt === -1 || !isChannelTurnPass(trimmed.slice(0, breakAt))) return trimmed;
  const remainder = trimmed.slice(breakAt + 1).trim();
  return remainder.length === 0 ? undefined : remainder;
}

/** Names in a notice, bounded so a full room does not print a roster. */
const NOTICE_NAMES_MAX = 4;

function nameList(names: readonly string[]): string {
  if (names.length <= NOTICE_NAMES_MAX) {
    return names.length <= 1
      ? (names[0] ?? "")
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
  }
  return `${names.slice(0, NOTICE_NAMES_MAX).join(", ")} and ${String(names.length - NOTICE_NAMES_MAX)} more`;
}

/**
 * What the room is told when a round ends having said nothing.
 *
 * Silence is the one thing every failure here looks like, which is why it is
 * worth breaking. On 2026-08-30 the operator typed into the room five times and
 * got nothing back twice over, for two unrelated reasons — no member held a
 * live seat, then a restart cut a round mid-answer — and neither was
 * distinguishable from a room that simply had nothing to add.
 *
 * A room where everyone genuinely passed still stays quiet: that is the design
 * (see `CHANNEL_TURN_PASS`) and it is not a fault. Only a round that failed to
 * reach someone says so, and it says it in the guild rather than the
 * transcript — the record holds what was said, not why nothing was.
 */
export function channelRoundNotice(round: {
  readonly spoke: number;
  /** Members never asked, or asked and never heard from. */
  readonly unreachable: readonly string[];
  readonly members: number;
}): string | undefined {
  if (round.spoke > 0 || round.unreachable.length === 0) return undefined;
  const who = nameList(round.unreachable);
  return round.unreachable.length >= round.members
    ? `No one here has a live seat right now, so nobody was asked — ${who}. Start their panes and say it again.`
    : `No answer: ${who} could not be reached, and everyone else passed.`;
}

/** What the room is told about a round its process did not survive. */
export const CHANNEL_ROUND_INTERRUPTED_NOTICE =
  "That round was cut off by a service restart, and no answer survived it. Say it again.";

/**
 * Who a notice is from. Not a member and not the operator: nobody said it, the
 * room did, and a name no persona can hold keeps it from reading as either.
 */
export const CHANNEL_NOTICE_AUTHOR = "room";

/** Transcript lines a member is shown, oldest first. */
const CHANNEL_TURN_TRANSCRIPT_MAX = 24;
/** Bounds the single line typed into a member's pane. */
export const CHANNEL_TURN_PROMPT_MAX = 8_192;

export interface ChannelTranscriptEntry {
  /** The durable character that said it, or absent for the operator. */
  readonly personaId?: string;
  readonly text: string;
}

export interface ChannelTurnPromptInput {
  readonly title: string;
  readonly member: OperatorChannelMember;
  readonly members: readonly OperatorChannelMember[];
  /** The transcript as it stands at this moment, including replies that just landed. */
  readonly entries: readonly ChannelTranscriptEntry[];
  /** Human-facing name shared by the app and Discord. */
  readonly nameOf: (personaId: string) => string;
}

/**
 * The single line typed into a member's pane when its turn comes.
 *
 * Single line is a hard constraint, not a style choice: herdr's `pane send-text`
 * writes raw bytes to the pty, so a newline inside the text lands as Enter and
 * submits a half-written prompt. Every line break in the transcript is folded
 * to a separator before it goes out.
 */
export function renderChannelTurnPrompt(input: ChannelTurnPromptInput): string {
  const roster = [...input.members]
    .sort((first, second) => first.position - second.position)
    .map((member) => input.nameOf(member.personaId))
    .join(", ");
  const transcript = input.entries
    .slice(-CHANNEL_TURN_TRANSCRIPT_MAX)
    .map(
      (entry) =>
        `${entry.personaId === undefined ? "operator" : input.nameOf(entry.personaId)}: ${flatten(entry.text)}`,
    )
    .join(" | ");
  return bounded(
    `[#${flatten(input.title)}] group chat · you are ${input.nameOf(input.member.personaId)} · members: ${roster} · ` +
      `reply with what you would say in the room, or exactly ${CHANNEL_TURN_PASS} if you have nothing ` +
      `to add or your point is already made · transcript: ${transcript}`,
  );
}

function flatten(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** Keeps the newest of the prompt when it runs long: the recent turns are the ones being answered. */
function bounded(prompt: string): string {
  return prompt.length <= CHANNEL_TURN_PROMPT_MAX ? prompt : `…${prompt.slice(-CHANNEL_TURN_PROMPT_MAX)}`;
}
