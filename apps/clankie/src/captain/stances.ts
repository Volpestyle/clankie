/**
 * What each agent last said it was doing with its own figure (ADR 0148).
 *
 * Deliberately in memory and deliberately expiring. A stance is a live
 * statement, not a fact: it is worth exactly as much as the agent that just made
 * it, and a restart or a lapsed deadline should leave the fleet describing
 * itself by what it is observed to be doing rather than by something an agent
 * said before lunch. Nothing here folds, so nothing here can outlive its feed.
 */
import {
  OPERATOR_AGENT_STANCE_DEFAULT_MS,
  OPERATOR_AGENT_STANCE_MAX_MS,
  type OperatorAgentStance,
  type StateOperatorAgentStance,
} from "@clankie/protocol";

export interface StanceStore {
  /** Record one agent's statement about its own seat and hand back what stands. */
  state(seatId: string, input: StateOperatorAgentStance): OperatorAgentStance;
  /** What this seat is saying right now, or undefined once it has lapsed. */
  read(seatId: string): OperatorAgentStance | undefined;
}

export function createStanceStore(now: () => number = Date.now): StanceStore {
  const stances = new Map<string, OperatorAgentStance>();

  const live = (seatId: string): OperatorAgentStance | undefined => {
    const stance = stances.get(seatId);
    if (stance === undefined) return undefined;
    if (Date.parse(stance.expiresAt) > now()) return stance;
    stances.delete(seatId);
    return undefined;
  };

  return {
    state(seatId, input) {
      // Every read prunes its own key, and every write sweeps the whole map, so
      // a stance whose seat left the roster goes with its expiry instead of
      // accumulating. The map is bounded by live statements either way.
      const at = now();
      for (const [key, standing] of stances) {
        if (Date.parse(standing.expiresAt) <= at) stances.delete(key);
      }
      const ttl = Math.min(input.ttlMs ?? OPERATOR_AGENT_STANCE_DEFAULT_MS, OPERATOR_AGENT_STANCE_MAX_MS);
      const stance: OperatorAgentStance = {
        pose: input.pose,
        ...(input.note === undefined || input.note.length === 0 ? {} : { note: input.note }),
        statedAt: new Date(at).toISOString(),
        expiresAt: new Date(at + ttl).toISOString(),
      };
      stances.set(seatId, stance);
      return stance;
    },
    read: live,
  };
}
