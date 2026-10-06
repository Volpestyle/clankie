# PC acceptance on runtime c72c3d02: allocation identity gap

VUH-1527 remains **In Progress**. The first new-intent hire on deployed runtime
`c72c3d028438a41d1d8666f516ff0c1dfe469501` stopped with an uncertain SSH outcome
before a worker allocation was recorded. Its exact original receipt remains
fenced. Report, peer exchange, startup catalog and the complete fresh acceptance
remain unproven on this runtime. [Bounded evidence](receipt-gap.json) records the
public result, original receipt, authenticated host journal and read-only PC
observations.

## Original receipt and recovery

The public hire at `2026-10-06T14:33:49.697Z` used fresh intent
`03fee986-a3c4-4501-a3bf-6cc4d8e34791`, after the retained abandonment of original
`719dd6b1-2814-4c2b-9eb6-118fb785427c`. It returned `start_unconfirmed`,
`deliveryStage: uncertain`, with `Session open refused by peer` and an SSH
handshake reset. No resend or alternative launch followed.

The new original `3989da1d-2af3-4a58-bae9-0b35aee0d828` retains its fingerprint,
host admission and irreversible `remoteLaunchCommitted: true`. It has no
`paneId`, `sessionId` or `occupantId`. The deployed operator recovery returned:

```json
{
  "state": "refused",
  "receiptId": "3989da1d-2af3-4a58-bae9-0b35aee0d828",
  "detail": "Original allocation is missing or still active."
}
```

At `14:48:14.469Z`, a read through the Windows-PC skill's LAN route matched the
host journal's exact original ID, key, fingerprint and nonce. The journal was
`launching`, opened at `14:33:55.242Z`, with no recovery evidence. This read did
not settle or modify it. A no-launch claim would be false; current absence cannot
establish the original launch outcome.

## PC observation and cleanup gap

The five baseline pane/terminal identities were unchanged after the failure.
The only additional observed pane was `wH:p1`, terminal
`term_65d2ce41e95bb1c`. At `14:45:44.368Z` it held one PowerShell shell, PID
`450920`, born at `14:34:07.390Z`, no descendants, and an empty prompt. Its
workspace has the expected repository label; the root tab still has label `1`.
The canonical Codex configuration hash was unchanged after the hire attempt.

These timing, cwd and census observations are consistent with the interrupted
workspace allocation. They do not bind that pane to the receipt. It remains
open pending confirmed ownership or an explicit lead cleanup instruction. No
other pane, PC account, configuration or desktop control was changed. No receipt
file was deleted.

LAN reads and Tailscale ping succeeded. The bounded `14:48` OS census observed
96 sshd processes, 72 born since `14:48:00Z`; no explicit `MaxSessions` or
`MaxStartups` override was found. This is an observed burst, not proof of its
source or of the SSH refusal's cause. No sshd process was killed or setting
changed.

## Approved recovery and next source work

The [native security assessment](SECURITY-ASSESSMENT.md) permits permanent
abandonment that explicitly retains an **unknown allocation outcome**, provided
the original authenticated journal, claim, target and complete current census
are checked. Such a record must preserve the original no-retry fence. It must
not claim no launch, guess a worker pane or adopt it.

Clankie explicitly approved authenticated unknown abandonment followed by a
separately authorized new read-only test at the same location. An unobserved
original could still finish after census. The implementation therefore uses a
distinct operator disposition, `abandoned-unknown`, that records this approval;
ordinary recovery does not acquire that permission accidentally. Deployment and
settlement of the exact original remain required before fresh acceptance.

Clankie also approved closing `wH:p1` conditionally on verified hire ownership,
idle state and an empty draft. The [fresh three-check observation](root-checks.json)
passed idle/draft checks, but ownership remains unverified. The pane was left
open and that failed condition was reported to Clankie.

Future allocations also need an immediate durable layout-only checkpoint of
Herdr's acknowledged workspace/root response before rename or metadata RPCs,
and a worker checkpoint before later RPCs. A root must remain distinct from the
worker allocation. Lost SSH responses require a host checkpoint before reply;
uncheckpointed outcomes stay uncertain.

## Earlier hand-started Queue proof

The [separate bounded recheck](hand-queue-earlier-run.json), on runtime
`7ee4da04` before this deployment, passed without a source repair. In owned
`wG:p1`, native `--no-daemon` Codex stored its report once; Steer definitely
rejected with `Nothing was sent.` A different fresh Queue request was accepted
and consumed. Native turn `01a1114c-e2bb-71e3-81d0-ced7e8c97edd` completed at
`13:00:24.959Z` with `TESS1527_LOOP_HAND_QUEUE_REPLY_OK`. Cleanup restored all
five baseline pane identities and removed all 20 captured test PIDs. This
supersedes the earlier failed Queue observation for that recheck, while retaining
the [earlier failed run](../7ee4da04/README.md) as history. It is not a new-runtime
acceptance claim.

This checkpoint changes only evidence and its current-result pointer. The
[unchanged source checks and review](../../sender-naming/CHECKS.md) remain valid:
70 focused tests, Clankie typecheck, scoped lint and formatting passed under the
heavy limiter. Pell reported the deployed exact full gate passing. New evidence
received scoped formatting, JSON consistency, local-link and diff checks. No new
source suite, full `pnpm check`, eval or simulator ran. Claude acceptance still
waits for James's personal PC `/login`; the follow-up issue awaits the non-Claude
closure gates.
