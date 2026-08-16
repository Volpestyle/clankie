# apps/clankie/src/memory.ts

`createFileMemory()` provides bounded file-backed Discord person facts and captain episodes beneath `~/.clankie/memory` (or `CLANKIE_MEMORY_DIR`). `MemoryStores` supports ambient recall, operator export/catalog, record/update/delete operations, and trusted per-lane episode cards.

Person facts live in escaped guild/user JSON files with expiry and visibility filtering. Episodes form a global bounded chronological ring rewritten into per-lane JSONL files; non-operator recall sees only `shareable` notes, while operator catalog/mutations see the full set. Atomic private writes and tolerant readers keep torn/corrupt entries from breaking turns.
