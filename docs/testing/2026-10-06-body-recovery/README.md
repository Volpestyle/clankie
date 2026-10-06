# VUH-1752: automatic verified body recovery

Core candidate for [VUH-1752](https://linear.app/vuhlp/issue/VUH-1752).
No live body lease, browser session or deployment was changed.

The service sweeps at boot and retries failed stop proof with backoff from
5 seconds up to 60 seconds. It only attempts recovery for a lease marked
`recovery_required`, after its holder's turn/driver has ended and all body
operations have settled. Every awaited boundary checks the exact lease token,
turn state and operation pins again. It uses the same guarded `confirmBodyStopped`
callback as operator recovery. Computer sessions retain their separate contract.
Shutdown withdraws check authority and waits for the original check to settle
before closing the body lease store.

Integration fixtures use a real Node body process over loopback HTTP, real
persistent leases, the recovery router and conversation store, with real timers.
The body initially refuses stop; only an explicitly allowed stop acknowledges
termination and exits. Short fixture intervals exercise the same capped retry
mechanism without waiting several production minutes. No model, browser or
lease-store behavior is mocked.

Observed boundaries:

- Restarted idle lease stays held across refused stop checks, then releases on
  acknowledged host exit; the durable registry contains no claim afterward.
- A live holder turn causes zero stop requests. Recovery begins after it settles.
- A live body operation causes zero stop requests, even if the holder is idle.
- A driver still settling cannot authorize recovery even if metadata says waiting.
- Active leases and the separate computer recovery contract remain held.
- A turn beginning during awaited discovery cancels stop and preserves the claim.
- Shutdown preserves a pending claim and sends no replacement check.

Checks through `clankie heavy --`:

- `pnpm exec vitest run apps/clankie/test/body-recovery.integration.test.ts apps/clankie/test/body-lease-router.test.ts apps/clankie/test/body-leases.test.ts apps/clankie/test/body-lease-routes.test.ts apps/clankie/test/conversation-driver.test.ts` — 41 tests passed before the added driver-settlement case.
- `pnpm exec vitest run apps/clankie/test/body-recovery.integration.test.ts apps/clankie/test/body-mouth-routes.test.ts` — 13 tests passed, including driver settlement and Discord receipt recovery.
- `pnpm exec vitest run apps/clankie/test/body-recovery.integration.test.ts` — all 7 final scenarios passed, including active-lease/computer exclusions.
- `pnpm --filter @clankie/clankie typecheck` — passed after the final changes.

50 distinct scoped tests passed across six relevant files.

The app acceptance criterion remains open outside this assignment's allowed
repository. In `clankie-app/packages/command-center/src/body/leaseStatus.ts:14`,
`leaseLabel` still returns only “stuck …”. Proposed text: “checking recovery;
if it persists, ask the owner to recover the body”, or an owner recover action.
The lead was notified of the exact source; `clankie-app` was not edited.

Full gate, integration and live recovery acceptance remain with the lead.
