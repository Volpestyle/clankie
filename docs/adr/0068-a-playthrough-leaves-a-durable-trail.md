# ADR 0068: A playthrough leaves a durable trail

Status: accepted (James, 2026-07-26). Implemented across the runner play
execution, the free-play session composer, the environment runtime, and the
GBA MCP server, with each piece covered by tests.

## Context

Clankie's first real asked-play sessions ([ADR 0063](0063-asked-embodiment-and-captain-started-play.md))
were reconstructable only as button presses. The `FreePlayTurn` record was
already well designed — monologue, intent, objective, notes, reply, speak,
outcome, effect — but the production path built each record, pushed a one-deep
overlay to the activity websocket, and dropped it. Four more gaps compounded
this:

- `FreePlayResult`'s end-of-run metrics (progress, volition, coherence) were
  computed and discarded when converted to the content-free receipt.
- The environment session id was stable per scenario
  (`gba-free-play:<scenario>:v<n>`), so every new run reused one record file
  and destroyed the previous run's action history at start; the record also
  rewrote its whole `actions` map on every persist — O(n²) for a marathon.
- MCP possession transitions ([ADR 0053](0053-mcp-possession-of-clankies-body.md))
  went only to the stdio server's stderr, which belongs to whatever harness
  launched it and dies with the process.
- The play host reported lifecycle to the control plane but logged nothing on
  the successful path, so the runner's own log was silent about a running
  playthrough.

After a session, an operator could answer _what_ he pressed but never _why_,
whether he was making progress, what he said, or who had been driving.

## Decision

Observability and operational state are split into two artifacts with
different rules:

- **The play journal is the observability artifact.** `openFreePlayJournal`
  (gba-emulator) writes one append-only JSONL file per run under
  `~/.local/state/clankie/gba-play/`: a header (run identity, environment
  session, scenario, resume lineage), one line per validated `FreePlayTurn` as
  it settles, and a summary line carrying the outcome plus the previously
  discarded metrics. The production play execution always journals; a failed
  append is reported and costs the record, never the playthrough. The journal
  is never rewritten or pruned by code.
- **The environment session record is operational state, bounded and
  per-run.** `createFreePlaySession` now embeds a start-stamped run id in the
  session id, so runs stop overwriting each other, and opts into
  `EnvironmentRuntimeRetention`: the newest 128 action records are kept (only
  terminal results roll, counted on the record — the no-silent-caps rule from
  [ADR 0061](0061-evidence-rolls-for-open-ended-play.md)), and the newest 16
  ended session records survive on disk. Frozen scenario drivers configure no
  retention and keep everything.
- **Possession transitions are durable.** The MCP server appends every lease
  event (acquired, released, expired, stolen, refused) to
  `possession-events.jsonl` beside `body.lock` in the shared body root —
  across every server that ever serves the body. stderr keeps its live line;
  the file is the record. Logging observes the lease and never gates it.
- **The play host logs every lifecycle transition** (claimed, running,
  settled with its receipt, refused, failed) through the runner's structured
  logger, so `runner.log` narrates the same story the control-plane events
  record.
- The free-play CLI's default trace path is per-run
  (`artifacts/gba-free-play/trace-<stamp>.jsonl`) instead of one fixed file
  truncated at startup.

## Consequences

- A finished run is reconstructable end to end from files: why each action was
  chosen (journal), what each action did to the game (environment session
  record, within its retention window), how the run went (journal summary and
  receipt), who held the body when (possession log, body lock), and how the
  lifecycle unfolded (runner log, control-plane events).
- Idempotency for environment actions is now bounded by the retention window:
  a retry of an action older than the newest 128 dispatches anew. Retries are
  immediate in practice; the bound is the price of a bounded record.
- Observer MCP servers create a session record per launch instead of sharing
  one; ended-record pruning is what keeps that finite.
- The journal directory grows one file per run and is deliberately not pruned
  by code — deleting play history is an owner's call, never an agent's.
- `docs/08-observability-debugging.md` documents where every artifact lives.
