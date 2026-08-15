# apps/clankie/src/memory.ts

Small file-backed memory (replaced the deleted
memory-store package) behind the `MemoryStores`
interface, created by `createFileMemory()`.
Default root `~/.clankie/memory`
(`CLANKIE_MEMORY_DIR` overrides).

Two stores:

- Discord person memory — one JSON file per
  guild/user under `discord-people/` (ids
  URI-encoded so hostile ids cannot escape the
  dir). Facts upsert by factId, capped at 128
  per person with oldest-first eviction.
  Ambient reads filter by expiry and
  visibility: guild-scoped always, channel
  facts only in their channel,
  operator_private never; the operator export
  returns everything. Recall renders a bounded
  markdown card matched on a query substring.
- Captain episodes — append-only JSONL per lane
  under `captain-episodes/`. Recall card is the
  newest 8; non-operator lanes only ever see
  `shareable` episodes (operator_private stays
  at the console even in its own lane's
  ambient recall).

Torn tail lines are skipped, never fatal.
