# ADR 0068: A playthrough leaves a durable trail

Status: accepted (James, 2026-07-26). Implemented across the Clankie play host,
free-play session composer, environment runtime, and GBA MCP server.

## Context

An operator needs to reconstruct _what_ Clankie presses, _why_ he chooses it,
whether he is making progress, what he says, and who holds the body. The bounded
environment record alone cannot hold that full trail. `FreePlayTurn` contains
monologue, intent, objective, notes, reply, speech intent, outcome, and effect;
durable journals and lifecycle records assign each concern an owner.

## Decision

Observability and operational state are split into two artifacts with
different rules:

- **The play journal is the observability artifact.** `openFreePlayJournal`
  (gba-emulator) writes one append-only JSONL file per run under
  `~/.local/state/clankie/gba-play/`: a header (run identity, environment
  session, scenario, resume lineage), one line per validated `FreePlayTurn` as
  it settles (with optional `speechDeliveryId` when the turn reported to the
  voice room), and a summary line carrying the outcome plus the end-of-run
  metrics. The production play execution always journals; a failed
  append is reported and costs the record, never the playthrough. The journal
  is never rewritten or pruned by code. `speechDeliveryId` joins a turn to the
  content-free voice receipts for that report — spoken or suppressed — without
  writing room speech into the journal.
- **The environment session record is operational state, bounded and
  per-run.** `createFreePlaySession` embeds a start-stamped run id in the
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
  settled with its receipt, refused, failed) through the service's structured
  logger, so the service log narrates the same story as lifecycle events.
- The free-play CLI's default trace path is per-run
  (`artifacts/gba-free-play/trace-<stamp>.jsonl`) instead of one fixed file
  truncated at startup.

## Consequences

- A finished run is reconstructable end to end from files: why each action is
  chosen (journal), what each action did to the game (environment session
  record, within its retention window), how the run is going (journal summary and
  receipt), who held the body when (possession log, body lock), and how the
  lifecycle unfolds (service log and lifecycle events).
- Idempotency for environment actions is bounded by the retention window:
  a retry of an action older than the newest 128 dispatches anew. Retries are
  immediate in practice; the bound is the price of a bounded record.
- Observer MCP servers create a session record per launch instead of sharing
  one; ended-record pruning is what keeps that finite.
- The journal directory grows one file per run and is deliberately not pruned
  by code — deleting play history is an owner's call, never an agent's.
- `docs/08-observability-debugging.md` documents where every artifact lives.
