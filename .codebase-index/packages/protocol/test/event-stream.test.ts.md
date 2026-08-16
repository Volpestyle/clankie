# packages/protocol/test/event-stream.test.ts

Pins event-stream identity: every reserved
namespace maps to its kind, unreserved ids read as
missions, exact matches don't swallow prefix
siblings, and `DomainEventSchema` never
materializes `streamKind` on parse so sealed
hashes of historical events stay stable.
