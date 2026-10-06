# VUH-1753: held update UX

Isolated candidate evidence for [VUH-1753](https://linear.app/vuhlp/issue/VUH-1753).
No live update, hold override, deployment or eval was performed.

The integration fixture runs real Git, loopback HTTP, bearer authentication,
private update records and the deploy hold store. It seeds seven CPU observations
from the ticket's 12–16% range. An unfinished fixture transaction prevents any
helper dispatch or runtime restart, even after an override is admitted.

Observed terminal excerpt (fixture SHAs and UUIDs omitted):

```text
Live: <old SHA>
Target: main <new SHA> (1 new commit)
  <new SHA> Explain held updates
7 CPU canary holds: CPU mean 12.0–16.0% vs 10.0% budget; health p95 1.3 ms, fine
Review the holds, then as owner run: clankie update --override-holds --reason "why proceeding is safe"
```

`runtime-update-ux.integration.test.ts` proves grouping, real target preview,
terminal canary policy, piped/explicit JSON, mandatory reasons, non-owner refusal,
server-derived audit actors, seven separate audit events, confirmation, refusal,
and a new hold acquired after preview continuing to block.

`runtime-canary.integration.test.ts` observes real processes for complete windows.
A newer pass clears an older verified failed hold, preserves its failed record
and release audit, and keeps unrelated/unverified holds. Pending and failed newer
observations retain the old hold. Existing restart, health identity, rollback and
foreign ownership checks also passed.

Checks (all through `clankie heavy --`):

- `pnpm exec vitest run apps/tui/test/update-command.test.ts apps/clankie/test/runtime-canary.integration.test.ts apps/clankie/test/runtime-canary-policy.integration.test.ts apps/clankie/test/runtime-update.test.ts` — 30 tests passed.
- `pnpm exec vitest run apps/clankie/test/runtime-update-ux.integration.test.ts apps/tui/test/runtime-update.integration.test.ts apps/tui/test/headless-captain.test.ts` — 25 tests passed.
- `pnpm exec vitest run apps/clankie/test/integrate.integration.test.ts apps/clankie/test/runtime-update-ux.integration.test.ts` — 14 tests passed before the additional legacy-actor check.
- `pnpm exec vitest run apps/clankie/test/runtime-update-ux.integration.test.ts` — all 5 tests passed, including legacy actor spoofing and HTTP reason validation.
- `pnpm --workspace-concurrency=1 --filter @clankie/tui --filter @clankie/clankie typecheck` — both passed.

An initial test location lacked the HTTP dependency; the fixture now lives in the
service package and passes. The integrator owns the full gate and live deployment
acceptance. This candidate does not fix the underlying idle CPU regression.
