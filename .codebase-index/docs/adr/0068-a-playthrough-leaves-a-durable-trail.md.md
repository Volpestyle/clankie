# docs/adr/0068-a-playthrough-leaves-a-durable-trail.md

Observability for play: an append-only JSONL play
journal per run (`~/.local/state/clankie/
gba-play/` — header, every settled FreePlayTurn,
summary with metrics; never pruned by code),
bounded per-run environment session records,
a durable possession-events log beside
`body.lock`, and play-host lifecycle logging.

Read to find where any play artifact lives, or
before changing session-record retention: run ids
are start-stamped so runs stop overwriting each
other, the newest 128 action records / 16 ended
sessions are kept (counted rolls, never silent),
and idempotency is bounded by that window. A
failed journal append costs the record, never the
playthrough.
