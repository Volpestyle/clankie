# VUH-2167: remote managed naming and fresh history

Tracks: https://linear.app/vuhlp/issue/VUH-2167

The deployed `37e8a04bf` bootstrap did run for the KH2 project's remote hire.
The remote lead called `hire_agent` at 10:02:52.527Z with fresh intent
`d711bea0-9bf4-4060-a2b9-781ce1058139`. At 10:03:28.119Z the Mac service
returned `not_ready`, `briefDelivery: not_sent`, for native root
`01a12f90-f88d-76b1-82c6-0be2874f237b` in `pc/w15:p4`.
This is separate from VUH-2169's earlier allocation refusal.

## Cause and change

Real native Codex 0.160.1 reports synthesized **read time** as `createdAt`
for an unpersisted root. Naming persists its metadata; subsequent reads report
its **actual creation time**. A delayed isolated example reported original
`1791799947`, pre-name read `1791799949`, post-name read `1791799947`.
The controller kept the pre-name snapshot and rejected the post-name timestamp
change in its fresh-history guard. The earlier fixture named its native root
before the controller's first read and missed this lifecycle transition.

The controller now uses the confirmed post-name snapshot for freshness and
continuity. Naming must preserve the exact identity, rollout path, ephemeral
and fork state. The persisted creation time must still belong to this view's
startup window. Empty initial inventory, idle sole root, no questions/turns,
exact error matching and irreversible dispatch fencing remain required.
Saved, forked, corrupt and post-dispatch failures remain closed.

## Proof and limits

The manual native integration fixture uses real installed Codex app-servers
and native RPC clients in temporary, credential-free homes. Its added case
waits over one second between native creation and the controller's naming,
then verifies exactly one persisted brief and its native turn ID. It uses the
real registration bookkeeping without admitting a remote host: this local
Unix fixture has no Windows process or fleet authority. No provider response
or native dependency is mocked. It proves acceptance and persistence, not a
successful authenticated model answer or a deployed Windows first brief.

The added case fails against the unchanged deployed controller with the exact
`missing source rollout` response (`native-before-fix.log`). The original four
native cases continue to cover fresh dispatch, missing saved history, missing
fork ancestor and corrupt persisted metadata.

Read-only PC captures confirm Codex 0.160.1, a sole idle non-forked root with
no turns, an absent rollout and the same native history error. A bounded clock
capture agrees with Mac time. The original native server and TUI remain alive.
No PC resume, turn, steer, pane close, setup write or hire retry was performed.
A deployed PC first-brief proof and deployment remain with the owner.

A diagnostic real TUI launch in a temporary local home did not create a root;
its failed capture is retained as `tui-metadata.log` and is not used as proof.
One native rerun passed its product assertions but failed fixture directory
cleanup while native plugin clone children were exiting. Its raw failed result
is retained. Cleanup now retries removal of the owned temporary directory.

Native runs passed 5/5 on installed Codex 0.160.1 and 0.162.1.
Focused controller/adapter checks passed 88 tests with one existing optional skip.
The added proof also exposed native input persistence races: reading history
immediately can precede item persistence, and interrupting immediately can
prevent it altogether. Those failed captures are retained. The proof now polls
for the exact persisted brief before interrupting the owned native turn.
Service source and test typechecks passed; touched-file format and lint passed.
Final check results are recorded in the attached raw logs.
The integrator supplies the exact-tree landing gate.

## Evidence archive

[Raw native proof and read-only captures](clankie://evidence/sha256/f0ab1c0fedf4c9ee06202c47b93f5cb68cd7125004f3ff146549ecb09d4ddc71)
are bundled in `native-proof.tar` (manifest: `evidence.json`). Extract the tar
for the named logs and inspection scripts. Final native results are 5/5 on
each installed version; service source/tests typecheck and touched-file
format/lint passed. The landing gate remains the integrator's responsibility.
