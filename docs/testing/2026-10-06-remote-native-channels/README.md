# Remote native channels and authenticated receipt recovery (VUH-1527)

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

## Legacy boundary

The original Codex hire `9a42ada0-5111-497e-b43c-25881932778c` allocated a shell
before preflight failed. Claude native hire `e70fd47b-264a-42c3-aac9-7f25b6636a4f`
allocated a pane and inserted its brief before expired login stopped work. Neither
legacy record has a historical host reservation. The [exact-byte no-launch
refusal](settlement/legacy-refusal.json) correctly refuses both; current absence
cannot prove they never launched. The positive-delivery and abandonment paths
below address those distinct dispositions without reclassifying them as no-launch.

## Focused verification

The worktree has a real independent frozen-lockfile installation, with no shared
dependency/cache symlinks. The final delta passed 98 focused tests in seven service
suites, including a real isolated Herdr server, OS census, host journal transitions,
PC-grounded native channel goldens, corrupt/conflicting mailbox journals, forged
metadata, duplicate attributes/events, invalid session IDs, sidechains, redirected
files, truncated histories, irreversible recovery and original-key retention.
Three CLI cases passed over real HTTP for no-launch, delivered and abandoned
requests, checking exact identity/disposition and refusal without redispatch.
Clankie/TUI typechecks, scoped lint, formatting, diff and documentation links passed.
No full `pnpm check`, eval, account login or production settlement ran.

## Follow-up recovery candidate

`clankie hire-receipt settle seat-71022bcd-8afe-44cd-9d83-bd71d1ceab42 delivered`
now has a supported operator-only path. It resolves the exact retained original
mailbox identity, authenticates a fresh host census, reads the original workspace's
native Claude history and attaches unique native channel-origin evidence. Historical
insertion is delivery; the login error does not establish completed work.

`clankie hire-receipt settle NATIVE_HIRE_UUID abandoned` records explicit operator
abandonment of an allocation, retaining prior uncertainty and current census proof.
Both commands retain all originals/evidence and block dispatch/adoption of those
intents. Recovery never closes panes, registers controllers or creates watches.
Normal exact-session recovery is fenced while operator recovery is in progress.

[Native security approval](settlement/SECURITY-REVIEW.md) covers the final delta.
[Authenticated PC program proof](settlement/pc-recovery-proof.json) recovered the
exact real event and recorded abandonment under an isolated test receipt. The host
had five panes, four native sessions and a complete process census. Both old
`pc/wA:p2` and `pc/wA:p3` are absent; no old pane was closed or adopted. Production
native receipts and the existing delivered ACK remain unchanged.

The [real operator API probe](settlement/production-api-refusal.json) returned
HTTP 400 for the new recovery request. Deploy this branch before settling the
production originals; do not write the journals behind the running service.
Then record delivered for the original channel event and abandoned for native
hires `9a42ada0-5111-497e-b43c-25881932778c` and
`e70fd47b-264a-42c3-aac9-7f25b6636a4f` through the supported CLI.

Fresh PC hire → brief → follow-up → peer acceptance remains unrun because the
requested original settlements need that deployed API. Claude's read-only auth
status reports `loggedIn:false`. James's exact login ask: on supedupsilly open a
new Claude terminal, run `claude`, then `/login` and complete personal sign-in;
tell Clankie when done. Use Codex for acceptance while Claude is signed out.
No accounts/configuration, existing panes or desktop controls changed.

VUH-1709 normal PC update still needs confirmation that Pell landed and deployed
`9ab0e1af`. VUH-1563's three-step James check is already on its ticket. The Linear issue read returned fleet-tool HTTP 403 during this run, but the
handoff comment at 03:58Z succeeded as Clankie ([comment](https://linear.app/vuhlp/issue/VUH-1527#comment-beeb7fd9-85c8-438d-b9e8-fb746a4114ea)). No other
Linear write returned 403 this turn, and no connector substitution was used. `message_clankie` remains fenced by its original uncertain
receipt; reports are visible in Tess's pane for Clankie to relay.

## Deployed recovery and fresh PC acceptance, 2026-10-06 05:35Z

Runtime `f6260751` contains the reviewed recovery. The supported operator CLI
successfully settled all three originals, in this order, without resend:

- [Original brief](live/original-delivered.json)
  `seat-71022bcd-8afe-44cd-9d83-bd71d1ceab42`: `settled-delivered`, with the exact
  authenticated native Claude event, session, entry ID and transcript hash.
- [Legacy Codex hire](live/original-codex-abandoned.json)
  `9a42ada0-5111-497e-b43c-25881932778c`: `abandoned`, with fresh host census.
- [Legacy Claude hire](live/original-claude-abandoned.json)
  `e70fd47b-264a-42c3-aac9-7f25b6636a4f`: `abandoned`, with fresh host census.

All journals and evidence remain retained. Both legacy allocations were absent;
no legacy pane was closed, adopted or relaunched. Positive insertion evidence
does not establish that the expired Claude account completed its old brief.

After the approved normal PC update to worker 0.6.6, a new owner conversation
`conv-b7ff6ebf-5264-4c94-8c74-5530d5a4cb45` dispatched exactly one Codex hire
into the granted KH2 directory. The [result](live/a-hire-result.json) is
`start_unconfirmed`: the remote launcher rejected `CLANKIE_EXPECTED_TOOL_NAMES`
in the controller's launch environment before creating the native server. No
brief, follow-up or peer message was delivered, and no fallback started.
The [new original receipt](live/a-original-receipt.json)
`719dd6b1-2814-4c2b-9eb6-118fb785427c` remains unresolved and retained. Do not
retry this hire or remove its claim. The two owned shell panes were empty with
no drafts before [cleanup](live/cleanup.json); the hook-test pane was also closed.
The final PC roster matches the original five panes.

The follow-up candidate consumes that controller metadata only if the identical
value is already present in the scoped bridge configuration. All other remote
environment/account overrides still fail before SSH. [Native security review](live/SECURITY-REVIEW.md)
approved the change. [46 focused tests](live/focused-tests.txt), Clankie typecheck,
scoped lint, formatting and diff checks pass. This candidate is not deployed;
native PC delivery, follow-up, completion wake, tracker isolation and peer-message
acceptance remain open. The failed test's original receipt also needs an explicit
supported disposition before a later acceptance attempt.

VUH-1709's normal update succeeded, but native worker hooks require owner trust
review before execution proof. Claude remains signed out; Clankie is passing the
existing `/login` ask to James. No accounts, manual config edits, other panes or
desktop operations changed. `message_clankie` still reconciles the old unresolved
receipt; the worker has no callable MCP refresh capability, so its original
controller needs to refresh that connection on the same thread. Linear reads and
tool discovery now succeed through Clankie's OAuth app.
