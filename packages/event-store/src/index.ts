import type { DomainEvent } from "@sapling/protocol";

export {
  GENESIS_HASH,
  parseStoredEvent,
  seal,
  verifyChain,
  type ChainVerification,
  type EventStore,
  type StoredEvent,
} from "./contract.ts";
export { JsonlEventStore } from "./jsonl.ts";
export { projectMission, type MissionProjection } from "./projection.ts";
export { SqliteEventStore } from "./sqlite.ts";

export function replayEvents<T>(
  initial: T,
  events: readonly DomainEvent[],
  reducer: (state: T, event: DomainEvent) => T,
): T {
  return events.reduce(reducer, initial);
}
