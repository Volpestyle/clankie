# Remote native channels: current source and remaining live gaps (VUH-1527)

Audit base: `origin/main` `8fcf47a5`, 2026-10-06. Linear issue and its five newest
comments were read, including the 2026-10-05 PC live acceptance and added peer
exchange criterion. Earlier source work remains on main; this candidate corrects
marketplace descriptions that still advertised retired Swarm dispatch/mail.

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

Thus supported recovery of that original no-launch remote failure remains a
code gap. Do not remove receipt files, change cwd to escape the key, or create a
replacement acceptance hire. The lead must decide the reviewed host-authenticated
settlement proof for the existing receipt machinery; this audit does not weaken
its security boundary or assert the old launch is settled.

Once the original receipts are settled and Claude login is repaired, verify native
Codex and Claude brief/follow-up/completion, actual inherited connector isolation,
and an owned link-loss outcome. The peer exchange added by Clankie needs two
owned panes in a confirmed connected PC fleet. An inactive named `kh2` session
must not be started or replaced as an incidental diagnostic.

No acceptance criteria are marked complete by this candidate. No accounts,
configuration, grants, existing panes or desktop controls changed.

## Focused verification

Real independent `pnpm install --frozen-lockfile`; no shared-tree dependency or
cache symlinks. Five focused suites passed, 117 tests: remote Claude isolation,
remote Codex registry/app-server, Claude worker channel, and harness profiles.
Clankie and TUI typechecks passed. Scoped lint for the affected native channel,
app-server and receipt code passed; changed-file formatting and diff checks passed.
No full `pnpm check`, eval, login, new remote hire, or receipt settlement was run.
