# apps/clankie/src/captain/conversations.ts

`ConversationStore` is the file-backed operator conversation registry: `meta.json` plus append-only `events.jsonl` per conversation. It serves list/get/create/replay/tail/send with revision fencing, line-count cursors, detached-run lifetime, optional Herdr seat metadata, and persisted Pi context occupancy.

Accepted sends append the operator and lifecycle events, then serialize the injected runner per conversation. Boot closes orphaned accepted runs as `service_restarted`, unreadable conversations are skipped, and unsupported legacy worker-steer/input requests answer explicitly rather than inventing a mission layer.
