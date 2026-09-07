import { OPERATOR_FLEET_EDGE_MAX, type OperatorFleetEdge } from "@clankie/protocol";

/**
 * How many prompt edges the captain remembers, and for how long. Herdr does not
 * keep prompt history, so this window is the one fleet fact the host must hold
 * (ADR 0163). Both bounds apply: whichever expires an edge first wins. The
 * ceiling leaves room for a full roster of spawn edges under the wire bound.
 */
export const PROMPT_EDGE_WINDOW_MAX = 64;
export const PROMPT_EDGE_WINDOW_MS = 5 * 60 * 1_000;

/** One `agent.prompted` event, keyed the way Herdr reports it. */
export interface ObservedPromptEdge {
  readonly fromPaneId: string;
  readonly toPaneId: string;
  readonly at: number;
}

/**
 * The captain's recent prompt window: bounded, process-local, never persisted.
 * It starts empty on restart, which is correct rather than lossy — an edge
 * nobody can still see is not a relationship the room should draw.
 */
export class PromptEdgeWindow {
  private readonly edges: ObservedPromptEdge[] = [];

  public record(edge: ObservedPromptEdge): void {
    this.edges.push(edge);
    if (this.edges.length > PROMPT_EDGE_WINDOW_MAX) {
      this.edges.splice(0, this.edges.length - PROMPT_EDGE_WINDOW_MAX);
    }
  }

  /** Newest first, oldest dropped. Reading prunes, so an idle captain drains. */
  public recent(now: number = Date.now()): readonly ObservedPromptEdge[] {
    const cutoff = now - PROMPT_EDGE_WINDOW_MS;
    let live = 0;
    while (live < this.edges.length && this.edges[live]!.at <= cutoff) live += 1;
    if (live > 0) this.edges.splice(0, live);
    return [...this.edges].reverse();
  }
}

/**
 * How long after a message the recipient's next turn still counts as its reply.
 *
 * Shorter than the window the edge itself lives in, deliberately: an agent turn
 * with tools in it can run minutes, so a reply has to be given real time, but a
 * seat that speaks half an hour later is starting something, not answering. At
 * three minutes a matched reply still has two minutes of the ring left to be
 * drawn in.
 */
export const REPLY_WINDOW_MS = 3 * 60 * 1_000;

/** A message the captain delivered itself, so it can name what was said. */
export interface ObservedSeatMessage {
  readonly kind: "prompt" | "reply";
  readonly fromSeatId: string;
  readonly toSeatId: string;
  readonly conversationId: string;
  readonly entryId: string;
  readonly at: number;
}

/** A turn landing in a thread, offered to the window to see if it answers one. */
export interface ObservedTurn {
  readonly seatId: string;
  readonly conversationId: string;
  readonly entryId: string;
  readonly at: number;
}

/**
 * Messages the captain carried between seats itself (ADR 0161's mailbox, and
 * the pty it falls back to), plus the replies they drew.
 *
 * Kept apart from the Herdr prompt ring because the two speak different
 * addresses: Herdr reports panes, and a message the captain delivered is
 * already about seats. Same bounds, same volatility — this is a window, not a
 * log, and a restart starts it empty.
 */
export class SeatMessageWindow {
  private readonly edges: ObservedSeatMessage[] = [];

  public record(edge: ObservedSeatMessage): void {
    this.edges.push(edge);
    if (this.edges.length > PROMPT_EDGE_WINDOW_MAX) {
      this.edges.splice(0, this.edges.length - PROMPT_EDGE_WINDOW_MAX);
    }
  }

  /**
   * Does this turn answer a message this seat was recently sent? If it does,
   * the reply is recorded and returned; if it does not, nothing happens and
   * the room simply ends that exchange without one.
   *
   * The newest unanswered prompt wins, and it is answered once: a seat that
   * keeps talking is having a conversation, not replying five times.
   */
  public observeTurn(turn: ObservedTurn): ObservedSeatMessage | null {
    for (let index = this.edges.length - 1; index >= 0; index -= 1) {
      const candidate = this.edges[index]!;
      if (candidate.kind !== "prompt") continue;
      if (candidate.toSeatId !== turn.seatId) continue;
      if (candidate.conversationId !== turn.conversationId) continue;
      if (turn.at - candidate.at > REPLY_WINDOW_MS || turn.at < candidate.at) continue;
      if (this.answered(candidate)) continue;
      const reply: ObservedSeatMessage = {
        kind: "reply",
        fromSeatId: turn.seatId,
        toSeatId: candidate.fromSeatId,
        conversationId: turn.conversationId,
        entryId: turn.entryId,
        at: turn.at,
      };
      this.record(reply);
      return reply;
    }
    return null;
  }

  private answered(prompt: ObservedSeatMessage): boolean {
    return this.edges.some(
      (edge) =>
        edge.kind === "reply" &&
        edge.conversationId === prompt.conversationId &&
        edge.fromSeatId === prompt.toSeatId &&
        edge.toSeatId === prompt.fromSeatId &&
        edge.at >= prompt.at,
    );
  }

  /** Newest first, oldest dropped. Reading prunes, so an idle captain drains. */
  public recent(now: number = Date.now()): readonly ObservedSeatMessage[] {
    const cutoff = now - PROMPT_EDGE_WINDOW_MS;
    let live = 0;
    while (live < this.edges.length && this.edges[live]!.at <= cutoff) live += 1;
    if (live > 0) this.edges.splice(0, live);
    return [...this.edges].reverse();
  }
}

/** A seat as the edge derivation needs it: its own pane, and its parent's. */
export interface EdgeSeat {
  readonly seatId: string;
  readonly paneId: string;
  readonly parentPaneId?: string;
}

/**
 * The fleet's edges for one snapshot, derived from the live roster plus the
 * recent prompt window. Every edge names two seats that are both on the roster
 * right now: a pane that has left, or one that never held a seat, yields no
 * edge at all rather than a dangling half of one.
 *
 * Every prompt in the window is carried, not one per pair. How often two seats
 * talk is the fact a surface draws with — a thicker wire, a worn path — and
 * collapsing a pair to its newest prompt destroys exactly that. The volume is
 * already bounded twice over, by the window that feeds this and by the wire's
 * own ceiling, so there is nothing left for a per-pair cap to protect.
 */
export function deriveFleetEdges(
  seats: readonly EdgeSeat[],
  prompts: readonly ObservedPromptEdge[],
  messages: readonly ObservedSeatMessage[] = [],
): readonly OperatorFleetEdge[] {
  const seatByPane = new Map(seats.map((seat) => [seat.paneId, seat.seatId]));
  const live = new Set(seats.map((seat) => seat.seatId));
  const edges: OperatorFleetEdge[] = [];
  const seen = new Set<string>();
  const add = (
    kind: OperatorFleetEdge["kind"],
    fromSeatId: string,
    toSeatId: string,
    at: string,
    said?: { readonly conversationId: string; readonly entryId: string },
  ): void => {
    // A seat never relates to itself: an agent prompting its own pane is a
    // person typing, not a relationship between two fleet members.
    if (fromSeatId === toSeatId || edges.length >= OPERATOR_FLEET_EDGE_MAX) return;
    // Only the same event twice is a duplicate. Two prompts between one pair
    // are two prompts, and the snapshot says so.
    const key = [kind, fromSeatId, toSeatId, at].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ kind, fromSeatId, toSeatId, at, ...said });
  };

  for (const edge of prompts) {
    const fromSeatId = seatByPane.get(edge.fromPaneId);
    const toSeatId = seatByPane.get(edge.toPaneId);
    if (fromSeatId === undefined || toSeatId === undefined) continue;
    // No conversation reference: this text was typed into a pane by someone
    // else's CLI call and the captain never saw it.
    add("prompt", fromSeatId, toSeatId, new Date(edge.at).toISOString());
  }
  // Messages the captain carried itself already speak in seat ids, and it can
  // say which entry each one was.
  for (const message of messages) {
    if (!live.has(message.fromSeatId) || !live.has(message.toSeatId)) continue;
    add(message.kind, message.fromSeatId, message.toSeatId, new Date(message.at).toISOString(), {
      conversationId: message.conversationId,
      entryId: message.entryId,
    });
  }
  for (const seat of seats) {
    if (seat.parentPaneId === undefined) continue;
    const fromSeatId = seatByPane.get(seat.parentPaneId);
    if (fromSeatId === undefined) continue;
    // A spawn edge stands for the life of the child, so it is timed from the
    // read that observed it rather than from a start nobody recorded.
    add("spawn", fromSeatId, seat.seatId, new Date().toISOString());
  }
  return edges;
}

/** The parent seat of each seat that has one on the roster, keyed by seat id. */
export function parentSeatIds(seats: readonly EdgeSeat[]): ReadonlyMap<string, string> {
  const seatByPane = new Map(seats.map((seat) => [seat.paneId, seat.seatId]));
  const parents = new Map<string, string>();
  for (const seat of seats) {
    if (seat.parentPaneId === undefined) continue;
    const parentSeatId = seatByPane.get(seat.parentPaneId);
    if (parentSeatId === undefined || parentSeatId === seat.seatId) continue;
    parents.set(seat.seatId, parentSeatId);
  }
  return parents;
}
