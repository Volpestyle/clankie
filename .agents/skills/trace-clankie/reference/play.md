# Play: gotchas

Traps that cost real time when reading play journals, screenshots and hosted worlds.

- **A failed session report does not prove the controls are free.** Shutdown
  can publish `failed` while the real execution promise is still draining.
  The conversation play lease remains pinned until execution settles and the
  world confirms departure. Restart recovery uses the exact saved world
  session; `unauthenticated`, a missing receipt, and a timeout keep ownership
  uncertain. The private session journal contains transport state and must
  never be copied into issue evidence or public status.

- **An empty play transcript receipt does not prove a broken wire.** Older
  `play_transcript_delivery` receipts include idle room input with
  `attachedCount: 0, deliveredCount: 0`. The play consumer connects only during
  a session; current listeners discard idle input without a delivery receipt.
  Positive delivered counts prove socket writes, not consumption by the mind:
  join those to the play journal’s interjection. The play host now starts on
  the first join or explicit observation, not service boot.

- **A play journal does not prove which code revision ran.** Its header has no
  source revision, and service logs carry the package version rather than the
  commit. Compare process/restart and commit times, then use fields actually
  present in the journal to prove capabilities; a process may also have started
  from uncommitted source, so do not infer an exact commit from timing alone.

- **A journal turn may name an action this build can no longer take.** The
  archive is read against its own history, not today's catalog (ADR 0160), so a
  run from before an action was retired still parses — `load_checkpoint` in the
  2026-08-11 runs, for one. The evaluator marks those turns `actionRetired` and
  counts them in `aggregate.retiredActionTurns`; their verdicts read `unknown`,
  which means the vocabulary is gone, never that the turn did nothing.

- **A screenshot reference is evidence only when its bytes match.** Resolve its
  relative `.screenshots/...` path from the journal directory and verify both
  `byteLength` and `sha256`; missing or mismatched bytes are a broken artifact,
  not permission to reconstruct a frame from a later state.

- **A missing play summary is not automatically an incomplete mystery.** Join
  the journal header `runId` to `embodiment.session.stopped` or
  `embodiment.session.failed` in `~/.clankie/events.jsonl`. A matching terminal
  event accounts for the run with its real outcome (including `lease_lapsed`)
  but never becomes a synthetic summary.

- **A hosted play has two session ids.** The play journal header's
  `environmentSessionId` is the Clankie embodiment id used for lifecycle joins.
  The PokeAgents session id (`ses_...`) lives in each V2 turn's
  `evidence.*.provenance.sessionId`; use that id to find the independent host
  journal under `~/.pokeagent-mmo/world/players/*/games/*/journal/`.

- **A journey is not a session.** New V3 journal headers carry `journeyId`;
  group those files to reconstruct Clankie's story across sittings. `runId`,
  `environmentSessionId`, hosted `ses_...`, and checkpoint ids still name one
  execution or saved state. V1/V2 journals predate this join and must not be
  assigned a journey from timing alone.

- **There is no current GBA possession trail.** Clankie's play host and every
  GBA MCP process own separate emulator/runtime instances. Trace Clankie's play
  through `gba-play/*.jsonl` plus embodiment lifecycle events; trace an MCP
  harness through its own stdio results and configured checkpoint directory.
  Old `body.lock` and `possession-events.jsonl` files are inert and intentionally
  neither migrated nor deleted.

- **`world_unreachable` is usually a missing process, not a crash.** The hosted
  world is a separate `pokeagents` server reached over a unix socket, so a
  refusal milliseconds after `embodiment.session.claimed` means nothing was
  listening. Check `ps aux | grep pokeagents` and compare its start time
  (`ps -p <pid> -o lstart=`) against the refusal — a join that lands before the
  server is up refuses, and the retry seconds later succeeds. `refused` is not
  `failed`: he never started, so there is no journal and nothing crashed.
