# VUH-2154 runtime canary

Tracks: https://linear.app/vuhlp/issue/VUH-2154/runtime-canary-fails-on-a-loaded-machine-and-silently-holds-the-merge

The canary now distinguishes host pressure from a quiet runtime regression,
reruns a complete quiet window, and reports failed observations at the top of
update status. Failure and pressure notices target the authenticated initiating
conversation and contain release and rollback commands. Cutover history and
retained older runtimes remain readable; no service restart or deployment ran.

## Proof

Final focused run: **65 tests passed across five files**. Focused lint and
format checks passed. The integrator supplies the exact-tree landing gate.

The first shared landing gate (`53dd3586`) failed on TS2375 in the pressure
sidecar reader: parsed optional properties admitted `undefined` under the
strict optional-property contract. This blocks landing. The reader now omits
absent fields after validation. The corrected focused run again passed all
65 checks; the failed gate and correction checks remain in the evidence archive.

The focused integration checks exercise real child processes, loopback HTTP,
private durable journals, deploy holds, real authenticated HTTP/CLI reads, and
Clankie's durable conversation notices. Controlled host observations isolate
pressure, quiet regressions, transport timeouts, identity failures and inflated
load averages. These host inputs are fixtures, not an idle-machine measurement.
The deliberately slow child answers health after 60 ms against a 40 ms budget;
it fails, keeps deploy admission held, and names the exact previous-healthy
rollback target. A pressured child remains pending beyond the window, then
passes only after a fresh complete quiet window. Unhealthy HTTP and wrong boot
identity fail even under pressure. Definite notification non-delivery retries
the same notice; uncertain delivery is never replayed.

`scenarios-native-cpu.jsonl` contains snapshots of pressure/rerun, slow regression
and bursty-load cases. `checks.json` records the final focused suite, lint, and
formatting. The earlier log retains the scheduler deadline failure; it is not
claimed as a pass.

## Machine pressure and pending gap

Tonight's incident measured 25% service CPU, health p95 2,373 ms, 15-minute load
9.6 on 18 cores, and a silent hold for roughly 30 minutes. During verification,
loadavg reached 96/59/32; the lead reported live CPU closer to five busy cores,
with gate/typecheck fork bursts inflating the run queue. The canary therefore
uses kernel CPU tick intervals when available and retains loadavg as context;
loadavg is a conservative fallback before its first valid CPU interval. The
candidate's own CPU contribution is subtracted from the host signal.

**Pending:** deliberately slow build on a genuinely idle machine, using native
host observations. The lead approved landing on the recorded integration proof
and will arrange a quiet window. Do not close this acceptance gap or call the
controlled quiet-host test an idle-machine proof. The service was not restarted;
deployment remains with the owner.
