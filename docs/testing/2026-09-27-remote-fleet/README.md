# VUH-1381 live proof, 2026-09-27

Later continuation: [schema-15 prompt/wait, desktop, remote hire and restart-watch proofs](schema15/README.md). The acceptance gaps below describe the earlier run.

Partial verification of `29cf9917`, continued on the shared Mac checkout.
[Issue](https://linear.app/vuhlp/issue/VUH-1381).

- SSH lists the sole existing `default` Herdr session. The console desktop is
  session 1, Active: [session transcript](sessions.txt).
- `herdr agent list` succeeded. The authorized scratch pane is a plain shell:
  `agent read w2:p2K --source visible` returned `agent_not_found`;
  `pane read w2:p2K --source visible` returned the [clean prompt](scratch-pane.txt).
  No input was sent and no other pane was read.
- `clankie herdr add pc --ssh volpe@supedupsilly --session default --shell powershell`
  succeeded: [registration receipt](fleet-add.json).
  `clankie herdr --connection pc agent list` returned HTTP 503
  `herdr_binding_unavailable` before the coordinated activation restart.
- One harmless bridge job, `1790527245886336000.ps1`, was queued through
  `desk.sh`: `query session; Get-Process -Id $PID | Select-Object Id,SessionId,ProcessName`.
  The wrapper timed out without a result; a subsequent read found that exact
  file still in `C:\desk\jobs`. The scheduled task reported `Ready`, not
  `Running`. No install, start, restart or duplicate submission was attempted.
  An Active console does not prove this job executed.

## After the shared repair restart

The `pc` fleet is healthy. The staged Windows managed Swarm runtime
`0981253` authenticated as the enrolled canary through the named pipe relay.
The [round-trip receipts](relay-roundtrip.json) record the common scope,
compatibility build, nonce, PC processing acknowledgment, Mac lead processing
acknowledgment and PC acknowledgment of the lead's final confirmation.
The Mac reply delivery expired once, was redelivered, and was acknowledged on
attempt 2; no dead-letter occurred. The TCP listener was observed only on
`127.0.0.1:64775`. No Rivals runtime was used or modified.

The CLI's remote connection path had incorrectly required a local socket
binding. It now reads the authenticated runtime inventory and uses the existing
allow-listed SSH transport for SSH fleets. Both remote `agent list` and the
[scratch pane read](routed-scratch.txt) succeeded through the corrected CLI.
The regression test verifies remote server-stop rejection without a local
binding request. The remote native viewer remains unsupported.

Validation: full `pnpm check` passed before the final CLI change; after it,
18 focused fleet/CLI tests and TUI typecheck passed. The integrating repair
coordinator runs the final full check and release build.

Acceptance gaps for the broader VUH-1381 issue: scratch agent prompt/wait;
desktop bridge session proof; remote hire; persisted watch surviving a
coordinated service restart; and the scheduled lead migration/crash proof.
The [handoff runbook](../../fleet-lead-handoff.md) is written, not executed.
The repair's narrower PC fleet reachability and authenticated relay round-trip
requirements are proven. No acceptance claim covers the remaining gaps.
