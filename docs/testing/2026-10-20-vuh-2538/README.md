# VUH-2538 — Windows brief bytes and prelaunch receipt recovery

Tracks: https://linear.app/vuhlp/issue/VUH-2538

Claude staging interpolated JSON into a PowerShell single-quoted string. The
UTF-16 EncodedCommand wrapper and outer base64 stdin transport did not protect
the inner source: PowerShell recognizes typographic apostrophes as delimiters.
The writer now transports UTF-8 bytes as base64 and uses `WriteAllBytes`, for
briefs, settings and appended prompt files. It emits no BOM.

## Live Windows transport proof

On 2026-10-20 at 05:53–05:55Z the source remote Claude adapter launched Claude
Code 2.1.303 / Haiku 5.5 in owned PC pane `w18:pQ`, in the granted workspace
`C:\Users\volpe\repos\fleet-proof`. The 270-byte brief contains `’ ‘ “ ”`,
backticks, `$`, `@`, newlines, Japanese, accented text and emoji, including
`Clankie’s own harness`.

The exact native session `fef0b75e-0070-4e69-8546-b59718114678` retains **one
complete decoded brief attachment**, one native startup reference and the
first-turn answer `VUH2538_PC_FIRST_TURN_OK`. The driver counted **one launch,
zero channel sends**. Read-back of the staged bytes matches the brief exactly;
there is no UTF-8 BOM. The staged JSON SHA-256 is
`e32583a9a6c70466ccfcab21272ee5f545fff18884c49fa7d06a6fc33de0f613`.
The owned pane was closed successfully after capture.

The first readiness receipt was **unconfirmed**, because the new workspace
stopped at Claude's trust prompt. The worker accepted that prompt in its own
pane, without relaunching or sending a second brief. Subsequent native transcript
capture proves the completed turn, not a successful initial hire receipt.
An initial driver preflight failed before pane creation because its SSH control
socket path was too long; the proof used an owned short `/tmp` control path.

## Separate Codex timeout

Receipt `db443061-0803-4538-ad21-4b5001fe2293` has exact remote admission but
**no launch commitment, pane, native session or occupant**. The SSH reservation
operation timed out; the host journal is absent. It did not reach Claude
staging. The contemporaneous service log also has failed fleet progress
observations. Historical machine pressure was not retained, so SSH/host load
is a possibility, not a proven cause.

The supported `not-launched` command refused the absent host journal. Recovery
must not fabricate a historical reservation window. The new `abandoned-unknown`
path accepts this exact uncommitted fresh Codex admission after operator
authority and a complete authenticated census. It writes an exact host tombstone
and records `launchHistory: uncommitted`; it claims neither historical
non-launch nor delivery. Both delayed reservation and launch calls then refuse.
Committed launches still require their original launching journal. Other
harnesses, resumes, mapped occupants and active originals remain refused.

Both old project allocations are already `gone: true` through the existing
failed-start path: Claude `35ea9259-c91a-45a6-b6fc-578434876fc9`, Codex
`181c9542-cfb2-432e-a8cf-27fa2c90dd65`. The Claude native receipt `18a96dd2` already
has retained authenticated abandonment. Releasing these already-gone allocations
again is refused rather than manufacturing an operator-release receipt.
The deployed follow-up below records successful supported live settlement of
the Codex native receipt.

## Checks

- 76 focused Claude/isolation tests passed.
- Receipt suite: 16 passed, two manual native tests skipped.
- Manual native prelaunch recovery: real isolated Herdr/process census, missing
  and reserved journal cases, durable settlement/read-back, and rejection of
  delayed reserve/launch all passed. No mocked dependency or model turn.
- Explicit changed source/test root compilation passed.
- File-scoped formatting/lint, swallowed-rejections and `pnpm deadcode` passed.
  Knip prints one existing unmatched-entry-pattern hint.

An attempted run of the older optional full native recovery scenario failed on
its stale fresh-hire admission setup (missing effort, then missing observed
usage). Its assertions were not weakened. The new native proof is independently
runnable by its test name; the ordinary receipt suite passes. The integrator
supplies the required root landing gate.

[Native capture, source drivers and check logs](captures.tar)

## Deployed public proof and live recovery

The lead deployed landed commit `2a16da2f0` and reported its runtime healthy.
On 2026-10-20 at 06:23Z, the supported CLI settled Codex receipt
`db443061-0803-4538-ad21-4b5001fe2293` as `abandoned-unknown`, with authenticated
`launchHistory: uncommitted` evidence (2 panes, 439 processes, 2 sessions).

A public `hire_agent` call initially hit an older unresolved Wren receipt
`9b7009dd-3d79-49e6-b856-c3e8a2f2d9d6` and started nothing. Its exact MCP hire ID
`6827bf37-8ab9-466f-b529-3735463f4be3` was reconciled read-only. The old native
receipt was abandoned through the supported operator path after authenticated
census proved `pc/w1A:p1` absent. The lead then explicitly authorized new work
referencing that predecessor.

Fresh intent `3f310dc0-8a38-479f-bd68-beb8762a4722` launched **one public PC
Claude hire**, in owned `pc/w1B:p1` and the granted `fleet-proof` workspace.
Claude Code 2.1.304 / Haiku 4.5 read the staged JSON and answered
`VUH2538_PUBLIC_FIRST_TURN_OK` on its first turn. Session:
`824f6394-6766-4ec1-9da0-4ed878cef056`. Read-back and native parsing prove:

- **2,150 UTF-8 bytes**, including all requested punctuation/newline/unicode
  cases and the service-appended standing preferences.
- **One complete decoded brief**, one launch, **zero channel copies**.
- Staged text matches the retained receipt fingerprint exactly; **no BOM**.

The public hire returned a false negative `start_unconfirmed` /
`brief_delivery_unverified`, native receipt `efc313f9-7023-4347-a12e-e64942ab4c3b`.
The pane showed: `clankie-worker: its classic.SessionStart hook was skipped.
"cc-plugin-sec-default" runs first and sent the event on past it.` The visible
read and the native transcript prove the first-turn answer despite that receipt.
`clankie agents read` also reported no recent session for the exact ID; direct
read of the exact `.claude-james` native transcript recovered it. These startup
and reader findings belong to VUH-2535; no hook changes were made in this lane.

Supported abandonment of `efc313f9` retained its exact present, done session.
The CLI rejected an extra `detail` response field after settlement had applied;
read-only journal verification and the supported settlement tool returned the
retained evidence. No hire was replayed. `close_worker_pane` then returned
**closed**, history `a3bbd246-575d-447e-a30b-43ef6b355f44`, at
**2026-10-20T06:31:51.662Z**, preserving the visible output and report. The
proof allocation and both original failed allocations are released.

[Deployed public hire, native transcript, pane read, settlement and closure](public-proof.tar)
