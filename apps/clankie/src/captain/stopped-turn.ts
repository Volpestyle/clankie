import { basename } from "node:path";
import type { HerdrAgentSnapshot } from "./herdr-watch.ts";
import type { SeatOutbox } from "./seat-outbox.ts";

/** Where one native session's turn is held, and how its conversation hears that it went quiet. */
export interface StoppedTurnHolds {
  /** A hired seat's fleet mailbox, keyed by its terminal. */
  mailbox(terminalId: string): SeatOutbox | undefined;
  /** The lead conversation this native session drives, when it drives one. */
  conversation(agent: HerdrAgentSnapshot): string | undefined;
  outbox(conversationId: string): SeatOutbox | undefined;
  /** Publish the conversation's `waiting` activity for this session. */
  publishWaiting(conversationId: string, sessionId: string): void;
}

/**
 * A confirmed Stop ends the turn (VUH-2680). Claude's Stop hook does not run
 * after a user interrupt, so nothing else reports it: without this, the turn
 * hold stays "responding" and a Queued message waits out the stale window.
 * Only the exact stopped session is settled; another session's hold is not
 * released (`SeatOutbox.observeTurn` refuses it).
 */
export function settleStoppedTurn(agent: HerdrAgentSnapshot, holds: StoppedTurnHolds): void {
  const session = agent.session;
  if (session === undefined) return;
  const sessionId = session.kind === "id" ? session.value : basename(session.value, ".jsonl");
  holds.mailbox(agent.terminalId)?.observeTurn(sessionId, "waiting");
  const conversationId = holds.conversation(agent);
  if (conversationId === undefined) return;
  if (holds.outbox(conversationId)?.observeTurn(sessionId, "waiting"))
    holds.publishWaiting(conversationId, sessionId);
}
