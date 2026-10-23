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
 * Capture both holds before requesting Stop. Claude's Stop hook does not run
 * after an interrupt, so a confirmed stop must settle its own hold. A later
 * turn observation or channel take invalidates the captured settlement, even
 * in the same session and millisecond (VUH-2686).
 */
export function prepareStoppedTurnSettlement(agent: HerdrAgentSnapshot, holds: StoppedTurnHolds): () => void {
  const session = agent.session;
  if (session === undefined) return () => {};
  const sessionId = session.kind === "id" ? session.value : basename(session.value, ".jsonl");
  const mailbox = holds.mailbox(agent.terminalId);
  const settleMailbox = mailbox?.stoppedTurnSettlement(sessionId);
  const conversationId = holds.conversation(agent);
  const outbox = conversationId === undefined ? undefined : holds.outbox(conversationId);
  const settleOutbox = outbox?.stoppedTurnSettlement(sessionId);
  return () => {
    if (holds.mailbox(agent.terminalId) === mailbox) settleMailbox?.();
    if (conversationId !== undefined && holds.outbox(conversationId) === outbox && settleOutbox?.())
      holds.publishWaiting(conversationId, sessionId);
  };
}
