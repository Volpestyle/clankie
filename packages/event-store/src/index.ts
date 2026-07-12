import type { DomainEvent } from "@clankie/protocol";

export {
  GENESIS_HASH,
  parseStoredEvent,
  seal,
  verifyChain,
  type ChainVerification,
  type EventStore,
  type ExpectedStreamAppend,
  EventStoreContentionError,
  OptimisticConcurrencyError,
  type ProjectionEventStore,
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
