# VUH-1885: fixture deadlines and pending HTTP rejection

The SSH fixture forced a four-second outer RPC/controller deadline around a native
Herdr request that permits ten seconds. A valid late native reply therefore retired
the healthy original controller and SSH forward and returned `undelivered/unavailable`.
Removing the fixture-only override uses the production budgets. Product defaults,
the global test timeout, concurrency and retries remain unchanged.

The [guarded ABBA record](reply-budget-abba.json) alternates original/default/default/original
while holding the same real native IPC reply for 4.25 seconds. Every arm had healthy
fleet pressure observations before and after. Both original arms failed and closed
the original helper and forward; both default arms passed, retained those transports,
and delivered exactly once. All arms allocated one layout. This proves the budget
boundary, rather than a performance speedup. A [subsequent traced repetition](ordering-race.json) identified an additional
ordering cause after removing that deadline override: 11 cases passed and one
failed. The completion watcher hit `settings_changed` in the machine-access read,
retired the original controller, then found no native control and returned the
unavailable hook fallback. Hire role adoption writes settings inside the existing
project-policy queue, but `admitProjectLaunch` performed its machine-access fenced
read before entering that queue. Put machine access and default-policy checks in
the same critical section. All checks still run; external changes still fail the
fence. There is no new retry, cached authority or relaxed admission. After the
repair, all 12 repetitions passed; all 64 settings/machine-access/project-policy
checks passed.

The simulator fixture started an HTTP request and then awaited a native inventory
barrier before observing that request's rejection. An owned HTTP connection closed
in this gap produces an unhandled fetch rejection. Observe rejection at creation,
return the original promise for the later assertion, and release/drain native work
in `finally`. No actual simulator is booted.

The [red/green record](simulator-rejection.json) captures the original request helper
failing with an unhandled rejection despite a passing assertion, followed by all
30 simulator integration cases passing with the repair. Vitest JSON reported
`success: true` in the red run: the actual exit status and unhandled-error log are
required evidence. Raw logs and JSON reports are retained in ignored
`.local/vuh-1885/`; these records include their SHA-256 hashes.

The inbound fixture started each child through `tsx`, repeatedly resolving and
loading a large TypeScript import graph before it could send `ready`. The
[cold-start ABBA](startup-abba.json) uses identical real service code with private
empty child temporary directories. Original arms loaded 1,198 modules, used
1.10/1.27 CPU-seconds and 635/640 MB RSS before ready, taking 1.21/1.43 seconds.
Bundled arms loaded 37 modules, used 0.27/0.33 CPU-seconds and about 239 MB RSS,
taking 0.23/0.28 seconds. All pressure observations were healthy. Compile once
in the fixture and restart fresh Node processes from that artifact, following
existing integration-fixture conventions. The ten-second ready limit remains.
All 13 restart/receipt tests pass with the artifact. This proves and removes
avoidable runtime loading cost; the exact original ten-second empty-output stall
has not been reproduced or traced, so its original scheduling delay remains an
explicit evidence gap.

Final acceptance requires three consecutive complete landing gates on landed main,
with a fixed nonempty changed baseline and the original SSH assertion selected.
The issue evidence comment records that main revision and the three gate results.
