# VUH-1803: host-local owner recovery for a lent screen

**Status: proposed.** This is built on branch `vuh-1803-night` and waits for the
owner's decision on the [ADR 0215 amendment](../../adr/0215-conversations-lease-one-body.md).
It is not on `main`.

## Why

Bounded lent input never proves native drain
([ADR 0256](../../adr/0256-lent-input-needs-native-drain-proof.md)). After any
input, both the parent and the helper refuse release for that session. The
remote `recover` refuses, and the VUH-2313 owner override covered only the local
Mac. The result is that a lent Mac or PC can carry one driven session, and then
its computer lease stays held with no supported way to clear it. Neither native
helper ends a session that carried input, and both refuse new consent while a
lease is bound. So a held lease also blocks every later session in that join
process.

## What changed

- **A new local control.** `MachineJoinLocalScreenCommandSchema` accepts
  `screen_recover` with `{reason, expectedHolder, expectedExpiresAt}`. Only the
  lent host's parent-owned `clankie join … --json` stdin can send it. The status
  reply gains an optional `recovery` field: `owner_override` with an `auditId`,
  or `refused` with a reason, detail and next step.
- **Host checks before the body.** The host first requires its native helper to
  be running. If the helper held the lease, it must report no busy, pending or
  held input (`native_input_active`). Then it calls the existing
  `ComputerBody.recoverByOwner` with host-created authority.
- **Body checks.** `recoverByOwner` now accepts `lent:` bodies, but only with
  that authority. It refuses an unexpired lease with a distinct
  `recovery_not_expired`. The expired-claim, exact-incarnation, idle-operation,
  fsynced-audit and audit-failure rules are unchanged.
- **What happens after a release.** The parent replaces its native helper, and
  the next session asks for local consent again.
- **The remote route stays refused.** The computer API refuses `ownerRecovery`
  for a joined machine, in both `computer-http` and `JoinedComputer`. The lent
  body also refuses an `ownerRecovery` command that arrives over the encrypted
  screen wire, because that wire carries no authority. Lent `recover` refusals
  now include `detail` and `next`.
- **The synthetic helper fixture follows the native contract.** Consent refuses
  while a lease is bound, and `end` refuses after an effect. The new test only
  passes when the helper is replaced. With the restart removed, the fresh
  acquire fails.

## Checks

All checks ran through `clankie heavy --`. Nothing captured a screen, sent native
input, requested permissions, deployed or restarted a service.

- **Baseline.** Current `origin/main` (`cc2eb50e5`) passed 12/12 in
  `joined-screen.integration.test.ts` before this change.
- **Focused tests.** The [focused tests](focused-tests.txt) cover the lent-screen
  suite (14 tests, two of them new) and the Mac owner-recovery suite
  (`computer-recovery.integration.test.ts`, unchanged).
- **Static checks.** [Typecheck](typecheck.txt) covers `@clankie/protocol`,
  `@clankie/clankie` and `@clankie/tui`. [Format](fmt.txt) and [lint](lint.txt)
  ran on the touched source files.
- **Mutation check.** With `native.restart()` removed, the new test fails at the
  fresh acquire.

The tests use real HTTP, encrypted join envelopes, the receiver, the body lease
store and an fsynced audit, plus an explicitly synthetic native subprocess. They
prove the authority and journal boundaries. They do not prove native
permissions, UI, person takeover or OS input.

## Open

- **Owner decision.** Accept, change or reject the ADR 0215 amendment. Until
  then this stays off `main`.
- **Desktop app.** The app's supervised join (clankie-app,
  [VUH-1802](https://linear.app/vuhlp/issue/VUH-1802)) does not offer
  `screen_recover` yet.
- **Daytime live proof.** Covered in the [runbook](live-proof-runbook.md).
