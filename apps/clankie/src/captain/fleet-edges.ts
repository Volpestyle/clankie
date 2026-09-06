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
 */
export function deriveFleetEdges(
  seats: readonly EdgeSeat[],
  prompts: readonly ObservedPromptEdge[],
): readonly OperatorFleetEdge[] {
  const seatByPane = new Map(seats.map((seat) => [seat.paneId, seat.seatId]));
  const edges: OperatorFleetEdge[] = [];
  const seen = new Set<string>();
  const add = (kind: "prompt" | "spawn", fromSeatId: string, toSeatId: string, at: string): void => {
    // A seat never relates to itself: an agent prompting its own pane is a
    // person typing, not a relationship between two fleet members.
    if (fromSeatId === toSeatId || edges.length >= OPERATOR_FLEET_EDGE_MAX) return;
    const key = `${kind} ${fromSeatId} ${toSeatId}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ kind, fromSeatId, toSeatId, at });
  };

  for (const edge of prompts) {
    const fromSeatId = seatByPane.get(edge.fromPaneId);
    const toSeatId = seatByPane.get(edge.toPaneId);
    if (fromSeatId === undefined || toSeatId === undefined) continue;
    add("prompt", fromSeatId, toSeatId, new Date(edge.at).toISOString());
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
