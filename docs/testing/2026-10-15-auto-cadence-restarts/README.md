# Restart-stable Auto cadence — VUH-2312

Tracks: https://linear.app/vuhlp/issue/VUH-2312

The service now saves its next Auto check deadline and each lead's accepted or
pending delivery fingerprint. An overdue startup checks once promptly; missed
intervals coalesce. The ordinary project routing, paused autonomy, two-hour idle
rewake and native delivery paths still decide whether a wake is admitted.

## Focused proof

`clankie heavy -- pnpm exec vitest run apps/clankie/test/runtime-provider.integration.test.ts apps/clankie/test/auto-velocity.integration.test.ts --disableConsoleIntercept`

**14/14 tests passed**, exit 0, 25.57 seconds. `focused-restarts.log` retains the
actual native events, round records, saved deadlines and test results.

- A real captain with native head and project-lead endpoints restarts three times
  inside its five-second test interval. Every restart retains the original deadline.
  The fixture then stops past that deadline and restarts. The overdue check runs
  promptly and normal native delivery succeeds: deadline `20:47:23.012Z`, project
  lead acceptance `20:47:23.272Z`, one accepted round per destination.
- Another overdue restart preserves the accepted fingerprint and timestamp,
  emits no unchanged wake and leaves exactly one project-lead round in the journal.
  An overdue restart with the master switch paused emits no wake either.
- A real built-in tracker, Git origin and round journal prove recovery after
  interrupted settlement: unknown acceptance stays suppressed inside the idle
  window, becomes eligible after two hours, journal acceptance recovers its
  timestamp, definite refusal permits retry, and a stale settlement cannot clear
  a newer delivery reservation.
- Existing cases retain project eligibility/routing, master-switch refusal,
  capacity context, velocity, drift and milestone reporting behavior.

Independent native subagent review found no blockers after reviewing the final
implementation, acceptance cases and docs. Its prompt catch-up assertion was
added; settlement writes also catch journal and cadence errors independently.

## Limits

This is isolated native-runtime and storage integration proof. No deployed runtime
was restarted, no deploy hold was changed, and no evals ran. The required root
landing gate is recorded separately on the issue before closure.

On first upgrade, old journal entries can supply the deadline but have no saved
fingerprint, so an unchanged lead may wake once. Later restarts retain its fence.
An uncertain delivery remains fenced for the ordinary idle window; this is bounded
duplicate suppression, not an exactly-once acknowledgement across a crash.
