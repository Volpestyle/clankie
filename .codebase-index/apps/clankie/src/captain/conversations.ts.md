# apps/clankie/src/captain/conversations.ts

File-backed operator conversation registry using per-conversation `meta.json` and append-only `events.jsonl`. `ConversationStore` guarantees one default global conversation, provides list/get/create/replay/tail/send operations, fences stale revisions, serializes accepted message turns, persists context occupancy, and closes orphaned runs after restart.
