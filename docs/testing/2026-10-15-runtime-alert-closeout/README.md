# VUH-1702: sustained runtime alert closeout

The steady-state alert already ships. No second detector or alert route was
added. The source audit and fresh verification use public main
`01644e35451f08712366ec0c43c16765f79513c8`.

| Existing mechanism      | Scope                                                                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RuntimeHealthObserver` | Process CPU above 50% or slow/unavailable health above 1,000 ms, sustained for five minutes; 15-second samples and 30-minute cooldown. Runs throughout the service lifetime. |
| Runtime canary          | A new runtime's five-minute health window, sampled every ten seconds; 250 ms health p95 budget, CPU comparison advisory, machine-pressure deferral and deploy holds.         |
| VUH-2216                | Attribution and fixes for intermittent stalls, memory growth and slow roster calls. Does not replace the steady-state detector.                                              |

Both observers reuse fresh bounded local HTTP health probing. The sustained
observer records an alarm/recovery in `global-default`, routes it to the native
seat without a service-model turn, exposes status/doctor metadata, and emits
content-free hosted telemetry. Configuration already uses the shared revision-
guarded owner API and CLI/TUI settings.

Fresh focused verification: **14 tests passed across four integration files**.
This includes a real CPU loop and slow HTTP, exactly one alarm and recovery,
incident duration, conversation retention with zero model turns, status and
doctor, metadata-only telemetry, and exact native mailbox acknowledgments.
The native integration uses an owned protocol receiver, not the owner's TUI;
its dwell is accelerated, so it does not establish a new five-minute live
incident.

The prior natural live incident is recorded in VUH-1702's 2026-10-15 02:42Z
closeout evidence: one accepted alarm at 02:39:40.227Z, recovery at
02:41:40.464Z, duration **420,618 ms**, matching status/doctor and no alert-induced
service-model turn. That historical evidence is reused, not recreated or
inferred from the current runtime. A read-only sample at 21:55:53Z shows the
current observer enabled with default thresholds, healthy at **20.1% CPU / 1 ms
health**, while its separate deployment canary is pending.

The only remaining closeout item was including that incident in the owning
lead's next Linear project check-in. The first check-in after it, `c304248e`
(21:12Z), omitted the incident. The lead owns that update; the final tracker
evidence records its reconciliation.

`docs/cli.md` now distinguishes canary and lifetime alert behavior and lists the
incident/recovery facts to carry into a check-in. Raw focused checks, source
audit and read-only live observations are retained through `evidence.json`.
No live settings, lanes, canary holds or runtimes were changed or overloaded.
