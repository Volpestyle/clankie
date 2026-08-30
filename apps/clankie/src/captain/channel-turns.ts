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
export type ChannelTurnOutcome = "spoke" | "passed";

export interface ChannelTurnRecord {
  readonly seatId: string;
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
  readonly lastSpeakerSeatId?: string;
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
  const done = new Set(state.taken.map((record) => record.seatId));
  return [...state.members]
    .sort((first, second) => first.position - second.position || first.seatId.localeCompare(second.seatId))
    .find((member) => !done.has(member.seatId) && member.seatId !== state.lastSpeakerSeatId);
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
  readonly seatId: string;
  /** Members who already spoke on this message, in the order they spoke. */
  readonly spokeBefore: readonly string[];
  /** True when nobody has answered yet, so this member is first to respond. */
  readonly firstResponder: boolean;
}

export function channelTurnPrompt(
  state: ChannelTurnState,
  member: OperatorChannelMember,
): ChannelTurnPrompt {
  const spokeBefore = state.taken
    .filter((record) => record.outcome === "spoke")
    .map((record) => record.seatId);
  return {
    seatId: member.seatId,
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
  return state.members.filter((member) => member.seatId !== state.lastSpeakerSeatId).length;
}

/**
 * What a member answers with when it has nothing to add. Passing has to be
 * something the member can say in the same breath as an answer, because the
 * decision is the member's and is made in one turn — there is no second channel
 * to signal on. A pass is matched exactly and is never written to the
 * transcript, so a room full of passes stays silent.
 */
export const CHANNEL_TURN_PASS = "PASS";

export function isChannelTurnPass(reply: string): boolean {
  return reply.trim().toUpperCase() === CHANNEL_TURN_PASS;
}

/** Transcript lines a member is shown, oldest first. */
export const CHANNEL_TURN_TRANSCRIPT_MAX = 24;
/** Bounds the single line typed into a member's pane. */
export const CHANNEL_TURN_PROMPT_MAX = 8_192;

export interface ChannelTranscriptEntry {
  /** The seat that said it, or absent for the operator. */
  readonly seatId?: string;
  readonly text: string;
}

export interface ChannelTurnPromptInput {
  readonly title: string;
  readonly member: OperatorChannelMember;
  readonly members: readonly OperatorChannelMember[];
  /** The transcript as it stands at this moment, including replies that just landed. */
  readonly entries: readonly ChannelTranscriptEntry[];
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
    .map((member) => member.seatId)
    .join(", ");
  const transcript = input.entries
    .slice(-CHANNEL_TURN_TRANSCRIPT_MAX)
    .map((entry) => `${entry.seatId ?? "operator"}: ${flatten(entry.text)}`)
    .join(" | ");
  return bounded(
    `[#${flatten(input.title)}] group chat · you are ${input.member.seatId} · members: ${roster} · ` +
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
