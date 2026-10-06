# Remote native channels and guarded no-launch settlement (VUH-1527)

Audit base: `origin/main` `8fcf47a5`, 2026-10-06. Linear issue and its five newest
comments were read, including the 2026-10-05 PC live acceptance and added peer
exchange criterion. The initial `13b1e445` audit corrected marketplace Swarm
descriptions. Clankie then authorized the guarded recovery below.

## Implemented recovery

`clankie hire-receipt settle ORIGINAL_NATIVE_HIRE_UUID` calls the operator-only
API with that original identity. The service authors all evidence through its
configured SSH transport. Before any remote hire effect, it records a host
reservation and pins the exact host/session/key/fingerprint. The service persists
an irreversible launch guard before the host's exclusive launch transition.
Preparation, pane allocation, resume and send are all behind that barrier.

A still-reserved host journal can seal after a fresh Herdr pane/agent and OS
process census. Launch and seal share an exclusive lock, so a late original
cannot launch after sealing. The local receipt retains `settlement` evidence,
reported as `settled-not-launched`, permanently. Its original key cannot dispatch
again. Missing history, allocated identity, launch commitment, changed connection,
incomplete census or revoked authority refuses. No caller can submit its own proof.

[Native security review](settlement/SECURITY-REVIEW.md) approved the final design.
[Actual PC census](settlement/pc-census.json) at 2026-10-06T03:22Z proves the new
guarded host path through `volpe@supedupsilly`: 5 panes, 534 processes, 4 sessions;
same evidence on repeat inspection; late launch refused. This was a fresh census
test reservation with no hire, pane or harness requested. Its host journal remains
retained. It does not establish the old receipts' history or the hire acceptance.

## Source disposition

- Remote Codex hires have a dedicated loopback app-server, an owned SSH forward,
  original-thread delivery, tracker isolation and native completion handling:
  `apps/clankie/src/captain/remote-codex-app-server.ts`.
- Remote Claude uses the same native channel/Stop hooks as local workers:
  `apps/clankie/src/captain/remote-claude-worker.ts`. Isolation includes default,
  configured and ancestor connector sources, with ambiguous inputs refused.
- `apps/clankie/src/captain/herdr-watch.ts` retains native delivery fences.
  Claude Stop observations do not assert a per-message completion correlation.
  Lost or uncertain delivery never permits terminal typing or another launch.
- Independent linked workers reach Clankie through the worker bridge; fleet peer
  messages use verified bindings. Those paths need live acceptance, not rebuilding.

## Current PC observation

`clankie doctor --machine pc` and `clankie connections` reached the PC on
2026-10-06. Fleet `pc` was healthy and link state `ready`. The default Herdr server
was 0.9.3; the separate `kh2`/`kh2-desktop` sessions were not running. This is
transport/install evidence, not native delivery or completion evidence.

The worker bridge's initial `message_clankie` report returned `uncertain` with
original delivery ID `b7d832bc-6c6e-4cf6-8615-f9048869623c`. Subsequent calls only
reconciled that ID and returned the same unresolved outcome. No alternate route
or replacement was used. Peer tools later disappeared from this worker's catalog,
even while CLI fleet status reported peer messages enabled. A handoff to Pell
requires fresh proven seat discovery; `pell-f996` was not returned in the earlier
same-fleet inventory, which exposed native `term_*` recipient IDs.

## Remaining acceptance and recovery

The latest retained PC acceptance in Linear reports a Claude brief delivered to
its original pane followed by expired login. Original acknowledgement
`seat-71022bcd-8afe-44cd-9d83-bd71d1ceab42` remains uncertain. Do not resend that
brief or claim follow-up/completion until the same receipt is reconciled.

The original remote Codex hire `9a42ada0-5111-497e-b43c-25881932778c` failed
preflight. Its empty allocation was closed by its owner, but the durable native
hire fence remains. Current `performSpawnSeat` releases an absent **local** pane;
it does not release a remote pane, where a detached backend can outlive the TUI.
Its exact-session recovery requires original occupant/session and transcript
proof. A missing remote pane alone is insufficient. The MCP wrapper's
`reconcile_seat_call` is a separate read-only ledger, not a native-fence cancellation.

The new mechanism refuses both legacy native hires, which lack a recorded window
and already have allocated panes. [Exact-byte legacy refusal](settlement/legacy-refusal.json)
records the current originals evaluated in an isolated copy, with the real journal
hash unchanged. Claude's native hire UUID is `e70fd47b-264a-42c3-aac9-7f25b6636a4f`;
`seat-71022bcd…` is its message acknowledgement, not a native hire UUID, and the
brief was visibly delivered. It cannot truthfully become settled-not-launched.
Codex's closed shell also fails Clankie's literal no-pane condition. Neither old
receipt was changed or resent. No cwd/key substitution or replacement hire ran.

The lead needs positive-delivery recovery for the delivered Claude original and
a separately reviewed disposition for the legacy Codex allocation. Once those
originals are resolved and Claude login is repaired, verify native
Codex and Claude brief/follow-up/completion, actual inherited connector isolation,
and an owned link-loss outcome. The peer exchange added by Clankie needs two
owned panes in a confirmed connected PC fleet. An inactive named `kh2` session
must not be started or replaced as an incidental diagnostic.

No acceptance criteria are marked complete by this candidate. No accounts,
configuration, grants, existing panes or desktop controls changed. PC launcher/
plugin update still waits for Pell to land `9ab0e1af` on main and deploy; latest
observed `origin/main` remains `8fcf47a5`. VUH-1563's James check is already posted.

## Focused verification

Real independent `pnpm install --frozen-lockfile`; no shared-tree dependency or
cache symlinks. Five focused suites passed, 117 tests: remote Claude isolation,
remote Codex registry/app-server, Claude worker channel, and harness profiles.
Clankie and TUI typechecks passed. Scoped lint for the affected native channel,
app-server and receipt code passed; changed-file formatting and diff checks passed.
For the recovery change, 81 focused tests across six suites passed, including the
manual native integration with an isolated real Herdr server and OS census. It
covers retained host/state evidence, late-launch refusal, revoked authority, denied
preparation after launch commitment, no retry, original-key tombstones, legacy
refusal and non-API HTTP refusal. One additional CLI test passed over real HTTP,
checking the exact original-ID request and typed refusal with no redispatch.
Clankie/TUI typechecks, scoped lint and changed-file formatting/diff checks passed.
No full `pnpm check`, eval, login, original settlement or new PC hire ran.
