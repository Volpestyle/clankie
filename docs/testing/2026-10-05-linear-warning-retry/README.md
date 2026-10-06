# VUH-1705: retain a rejected budget warning

Pell's review of `93bbc0795f68eb152a088524116536627f7aebfd` found that the
50% warning latched before native admission. A false result, synchronous throw
or rejected promise left the warning suppressed until usage fell below 50%.
The startup text queue also discarded the eventual native result.

The correction is based directly on that reviewed commit. Each account retains
its current warning incident until `onAlert` returns exactly `true`. Rejected
admission retries at least 60 seconds after settlement, with one attempt in
flight. An unreferenced timer retries while provider traffic and status polls
are absent. Budget observations also admit a due retry before provider refusal;
this does not relax the provider cap, write dispatch fence or background quota.
Usage below 50% cancels the incident and rearms the warning. A late result from
an old incident cannot accept a new crossing; a newer incident waits behind any
older in-flight attempt. Shutdown cancels pending timers and prevents completed
attempts from scheduling more work.

Boot-time warnings await a readiness promise that binds the native handler;
their original attempt receives its real result. There is no independent text
queue that drops a failed result or resends a pending attempt.

The native API returns true for guarded delivered **or unconfirmed** admissions.
That stops budget retries while the original native receipt remains unresolved.
It is not independent evidence of alert receipt or model awareness. No native
recipient, credentials or live runtime were modified for this correction.

## Verification

The 20 focused budget integrations passed, including false/throw/rejected
admission, pending acceptance/refusal, settlement-time cooldown, stale results
across threshold crossings, retries before exhausted-budget refusal, and close
while admission is pending. The separately enabled autonomous test passed in
60.073 seconds: its second attempt occurred at least 60,000 ms after the first,
with the same account and only one provider request throughout.
[checks.json](checks.json) records test names, durations, input commits and
source/receipt digests. Production and ordinary test inputs are identical
between the two runs. The final evidence commit changes only documentation.

Focused checks use the existing real local GraphQL provider, credential store,
API tracker, MCP host, HTTP routes, CLI and dispatch receipts. The new tests
control only the notification-admission result and, for fast incident tests,
the existing clock seam. Native-channel receipt is outside this fixture.

The manual autonomous check uses the real wall clock and the production
60-second timer. It stays disabled unless explicitly requested:

```sh
~/.herdr-handoffs/clankie-backlog-20261003/bin/heavy env \
  LINEAR_WARNING_TIMER_TEST=1 pnpm exec vitest run --config vitest.config.ts \
  apps/clankie/test/linear-request-budget.integration.test.ts \
  apps/clankie/test/linear-request-budget-autonomous.integration.test.ts
```

The initial combined run skipped the manual test because repository isolation
removes `CLANKIE_*` variables. Its flag is now `LINEAR_WARNING_TIMER_TEST`,
consistent with other explicitly enabled manual lanes; the isolation rules are
unchanged. The separate manual run had one passing test and zero skips.

Clankie typecheck passed under the fleet limiter. Scoped lint, format and
local documentation links passed separately. No full integrator gate,
release, AWS deployment or live alert-delivery claim belongs to this proof.
