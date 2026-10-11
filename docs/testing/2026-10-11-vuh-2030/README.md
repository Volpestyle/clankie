# VUH-2030: one fleet proof-outage alert

Tracks: https://linear.app/vuhlp/issue/VUH-2030

## Result

The 2026-10-10 03:23 UTC burst pattern (one aggregate evaluation and thirteen
worker evaluations in the same second, sharing native initial/final
unavailability) produces one lead notice instead of fourteen. All thirteen
claimed panes appear in it. Further same-cause checks within the window do not
page again. Counters still retain every refusal.

The collector coalesces initial/final native unavailability into one outage
cause. An aggregate alert that is pending or cooling down suppresses matching
worker alerts. Different, significantly overrepresented reasons and refusal
rates at least twice the fleet rate and five percentage points higher retain
grouped worker alerts. Receipt acknowledgment and five-minute cooldown behavior
remain intact, including unresolved originals across caller inactivity.

Caller lists are computed only on alert delivery, not on every proof check.
Lists are bounded to respect the native notification's 4,000-character limit;
full labels remain available through `clankie metrics --fleet`.

## Before and after

The exact burst regression ran against the original collector from fetched
`origin/main` (`cdd373cab41ca375c2bccea59cff1322ba8c6200`). Only the new caller-list
formatting helper was retained to let the new test run; alert logic was the
original source. It failed as expected:

```text
AssertionError: expected [ ...14 messages... ] to have a length of 1
Expected: 1
Received: 14
Test Files: 1 failed
Tests: 1 failed | 19 skipped
Duration: 7.62s
```

With the fixed collector, the same burst passes through the real captain
notification and conversation-journal boundary in an isolated fixture. It
produces one durable external message and no duplicate notices during four
subsequent seconds of fleet-wide refusals. The captured record follows.

```json
{
  "messages": [
    "Fleet proof outage: 1301/1301. Affected workers: w1:p1, w1:p10, w1:p11, w1:p12, w1:p13, w1:p2, w1:p3, w1:p4, w1:p5, w1:p6, w1:p7, w1:p8, w1:p9."
  ],
  "notices": [
    {
      "schemaVersion": 1,
      "conversationId": "global-default",
      "cursor": "000000000001",
      "revision": 1,
      "occurredAt": "2026-10-11T07:00:59.527Z",
      "type": "message",
      "role": "external",
      "text": "Fleet proof outage: 1301/1301. Affected workers: w1:p1, w1:p10, w1:p11, w1:p12, w1:p13, w1:p2, w1:p3, w1:p4, w1:p5, w1:p6, w1:p7, w1:p8, w1:p9.",
      "streaming": false
    }
  ],
  "totals": {
    "proof": {
      "attempts": 1365,
      "refusals": 1365,
      "byReason": {
        "native_initial_unavailable": 735,
        "native_final_unavailable": 630
      }
    },
    "reports": {
      "attempts": 0,
      "failures": 0,
      "byReason": {}
    },
    "nativeDiagnostics": {},
    "transportDiagnostics": {}
  }
}
```

## Checks

- Focused metrics, fleet-lead notification, worker-bridge health, and report
  reasons: 47 tests passed, 2 native opt-in tests skipped (40.96s).
- Both new targeted regressions passed: the exact burst and grouped distinct
  causes/rate outliers. The latter caught and corrected an early comparison
  that mistook fleet-like workers for a distinct reason profile.
- `clankie heavy -- pnpm --filter @clankie/clankie typecheck`: passed.
- Focused `oxlint --deny-warnings`: passed.
- Formatter ran directly on all touched files under the lead's interim rule.
- Tests, installation and typecheck ran through `clankie heavy`.

## Gaps and landing

This reproduces the reported fourteen-message pattern with synthetic proof
observations and a real isolated captain/journal. It does not induce an outage
in the owner's running fleet or claim the original historical counters were
recovered. The opt-in native proof suites require `FLEET_PROOF_NATIVE_TEST=1`
and `PROJECT_NATIVE_PROOF_TEST=1` and were not run. No evals or local full root
gate ran; the integrator owns landing validation. The lead closes after landing.
