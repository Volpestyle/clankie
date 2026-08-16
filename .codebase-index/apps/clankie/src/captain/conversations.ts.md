# apps/clankie/src/captain/conversations.ts

`ConversationStore`: file-backed operator
conversation registry — `meta.json` plus
append-only `events.jsonl` per conversation
under the captain state dir. Serves the wire
contract the TUI and relay speak:
list/get/create/replay/tail/send with revision
fencing and cursored pages (zero-padded
line-count cursors).

Behavior:

- `send` rejects on revision conflict, appends
  the operator message + turn-accepted event,
  then chains the injected `ConversationRunner`
  per conversation; completion/failure appends
  the terminal turn event and updates
  sessionState.
- Boot recovery: a crash mid-run leaves
  "active" metas — reset to waiting and close
  each orphaned accepted-but-unterminated run
  as failed `service_restarted`, so no client
  tails forever.
- `worker_steer` and typed-input submissions
  answer `unsupported` (workers are herdr panes
  now).
- `awaitRun(runId)` keeps a detached run alive
  for a transport's waitUntil; `close()` awaits
  all runs. Unreadable conversations are
  skipped on boot, never fatal.
