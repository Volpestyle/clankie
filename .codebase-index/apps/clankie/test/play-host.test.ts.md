# apps/clankie/test/play-host.test.ts

`PlayHost` lifecycle with a fake embodiment
client and fake executions: claim → running
(with resume lineage) → stopped with the
receipt; the lifecycle narrated into the runner
log; claim-poll failures logged once per
signature plus one recovery; refusals reported
without ever reporting running; stops delivered
at the next turn boundary; shutdown deadlines
forcing a truthful failed state (bounded even
when the forced report itself hangs); mid-run
throws reported failed with a receipt;
reconcile marking a dead process's running
session failed lease_lapsed and its claimed
session refused, leaving other runners' sessions
alone; and double-assigned starts refused
instead of run in parallel.
