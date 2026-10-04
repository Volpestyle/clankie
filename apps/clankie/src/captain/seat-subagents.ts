import { readClaudeSubagents, readCodexSubagents } from "@clankie/agent-transcript";
import type { OperatorFleetSeat, OperatorSeatSubagents } from "@clankie/protocol";
import type { ObservedFleetSeat } from "./herdr-census.ts";

/**
 * Attach native subagents to the seats the host already has an address for
 * (ADR 0208). Discovery alone never reads a transcript (ADR 0188): a seat is
 * read only once it was hired or the owner opened its chat. Local Claude/Codex
 * only; a remote fleet would cost an SSH round trip per seat per fleet read.
 */
export function withSeatSubagents(
  seats: readonly OperatorFleetSeat[],
  observed: readonly ObservedFleetSeat[],
  addressed: (seat: OperatorFleetSeat) => boolean,
  read: (
    harness: "claude" | "codex",
    session: NonNullable<ObservedFleetSeat["session"]>,
  ) => OperatorSeatSubagents | undefined = (harness, session) =>
    harness === "claude" ? readClaudeSubagents(session) : readCodexSubagents(session),
): readonly OperatorFleetSeat[] {
  const sessions = new Map(observed.map((seat) => [seat.seatId, seat.session]));
  return seats.map((seat) => {
    const session = sessions.get(seat.seatId);
    if (
      (seat.harness !== "claude" && seat.harness !== "codex") ||
      seat.fleet !== undefined ||
      session === undefined ||
      !addressed(seat)
    )
      return seat;
    let subagents: OperatorSeatSubagents | undefined;
    try {
      subagents = read(seat.harness, session);
    } catch {
      // An unreadable transcript is an unknown count, never a failed roster.
      return seat;
    }
    return subagents === undefined ? seat : { ...seat, subagents };
  });
}
