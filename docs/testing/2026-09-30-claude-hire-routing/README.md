# VUH-1478: Claude hire routing

The local hire skipped the Claude worker adapter whenever a remote fleet was
registered. `captain.ts` constructs its runner with `routeHerdrFleets`; that
wrapper forwarded `startAgent` but omitted `runInPane`. `HerdrWatchStore.spawnSeat`
requires `runInPane` before selecting any adapter, so consent was never checked
and the brief was typed. `clankie runtime list` confirmed an enabled `pc` fleet
on the affected service. With no remote fleets the router returned the original
runner, explaining why direct adapter tests passed.

The router now forwards pane execution. Every hire result that selects a lane
reports it, and every result logs the lane and reason. Claude uses `channel`,
Codex uses `adapter`, and terminal fallback names its reason. Plugin inspection
errors are distinguished from a missing plugin. Both adapter and terminal
startup failures inspect the pane before cleanup; a visible folder-trust prompt
returns `trust_required`. The public hire/move schemas preserve the new fields.

## Verification

- [Focused tests](focused.txt): 106 tests passed across the Claude adapter, hire
  integration, fleet router, Herdr watcher, Codex hire and public result schema.
  The routed integration uses the real Claude adapter with mocked process,
  mailbox and transcript boundaries. It checks approved consent, the channel
  flag, Haiku selection, mailbox delivery, no terminal prompt, lane logging,
  and typed trust failure followed by cleanup. The full run exposed an older
  Codex trust assertion still expecting `not_ready`; it now expects
  `trust_required`, and all nine tests in that file pass on the follow-up run.
- [Regression before the router fix](regression-before.txt): removing only the
  forwarding fix makes both registered-fleet regression cases fail because
  `runInPane` is absent. The fix was restored immediately afterwards.
- Full `pnpm check`: formatting, lint, dead-code, docs, infrastructure and all
  27 typechecks passed. Vitest finished with 383 files passing and two failing
  (3,263 tests passed, three failed, two skipped). One failure was the old Codex
  trust assertion corrected and rechecked above. The other two are
  `play-voice.test.ts` lazy-HTTP-join journal assertions in another active lane;
  those files were left untouched. The later Rust tests and Vox smoke did not
  run because Vitest failed. See [check output](check.txt), with routine JSON
  test-service events omitted. The newly added archive also passed `pnpm docs:check`.

No real hires, service restart, eval campaign or push were performed. These are
offline regression results, not proof of a live channel receipt.

## Live verification after James restarts the service

Use the actual `hire_agent` tool once in the already-trusted
`/Users/james/dev/clankie`, with `harness: "claude"`, `model: "haiku"`, a short
title and the one-line brief `Reply exactly VUH-1478-OK.` Keep the registered
remote fleet enabled to exercise the formerly broken path.

Check `control.mode: "channel"`, the `hire_agent:` log, launch arguments containing
`--channels plugin:clankie-worker@clankie`, and the complete brief inside a
`<channel ...>` transcript event. Close the returned seat after inspection,
including on a failed probe. At most two real probes total; no fresh-folder
probe is needed because the trust blocker has offline regression coverage.
Attach the live receipt to VUH-1478 before treating live acceptance as complete.
