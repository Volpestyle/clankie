# VUH-2389: fleet proof once per connection

Issue: https://linear.app/vuhlp/issue/VUH-2389

On 2026-10-17 the live service ran about 16 local fleet proofs a second against
a handful of worker reports, and `native-process-proof --serve` used 40–80% of a
core (`raw/live-before.txt`). VUH-2062 had cut idle re-proofs on 2026-10-10.

## Why VUH-2062's fix didn't hold

Two causes stack.

1. **Parked seats never left the 5-second catalog check.** VUH-2062 lets a
   bridge skip its 5 s `tools/list` while the seat long poll pushes an
   unchanged catalog revision, unless the listing reports `refreshPending`.
   The service's `catalogRefreshPending` (`apps/clankie/src/index.ts`) answers
   `true` for every seat whose Herdr status is not `idle` or `ready`. So a
   `working` seat, and a `done` one, sets the bridge's `catalogHeld`, and its
   `catalogCurrent()` stays false. Herdr marks a finished turn nobody has looked
   at yet as `done`, which is the resting state of a parked hire: 31 of 43 agent
   panes when sampled. VUH-2062's after-measurement used a freshly hired `idle`
   pane, which hid this. On the live fleet, `done` and `working` Claude panes ran
   a median of 82 and 146 proofs per 5 minutes against 27 for `idle` ones
   (`raw/live-before.txt`), and their bridges opened about 25 connections per
   152 s against about 10 (`raw/live-bridge-connections.txt`). Codex bridges
   started without an approved channel never long-poll, so they get no pushed
   revision either (inferred from `seat-channel.mjs`; not separately measured).
   This polling belongs to VUH-2390.
2. **Every one of those requests paid a full proof on a new connection.** Node's
   server keep-alive defaults to five seconds, and Node's `fetch` closes an idle
   connection a margin before the server's hint, so even a 3.5 s gap opened a
   new connection (`raw/keep-alive.txt`). Each request then ran two
   whole-machine descriptor censuses, and seat routes prove twice per request
   (`LocalFleetLink`, then `fleetSeatPane`). An `idle` pane's 25 s long poll alone
   is about 24 proofs per 5 minutes, which matches the 25–29 measured.

The rate therefore grows with the number of parked panes; about 40 panes gave
the 14–16 proofs a second seen.

## Change

A successful local fleet proof is bound to its connection, and the local fleet
listener keeps idle connections for ten minutes so that Node `fetch` clients
reuse them. A later request on the same live socket skips the census and
rechecks the socket, pane claim, Herdr binding and shell, the owner's lineage at
its kernel births (PID-local `--birth`), and any private-seat registration. A
failed recheck runs the full proof. The rules, the one residual (a descriptor
handed off after the proof) and the ADR amendment are in the
[native helper README](../../../integrations/fleet-proof/README.md#proof-once-per-connection)
and [ADR 0217](../../adr/0217-fleet-membership-gets-connected-tools.md). No bridge
changed.

## Results

**Ten real bridges** (`raw/ten-bridge-benchmark.txt`): the existing
frequency benchmark, run on the previous proof code and then on this change,
60 s each, same 70 requests and 90 `validate()` calls. Full proofs went from 90
to 0 and new connections from 50 to 0 during the interval. Native helper CPU
went from 2,257 ms to 67 ms. Body, Herdr and bridge CPU stayed within run-to-run
noise (body 766 → 879 ms).

**Boundary** (`raw/native-integration.txt`): the native integration test passed
with the real helper and an isolated Herdr. Twenty warm requests on one
connection ran no census (p95 13.5 ms, against a 115.6 ms cold full proof).
A proven owner that handed its connection to a child and exited was refused on
that same connection with `owner_mismatch`, and nothing was forwarded. A socket
shared before the connection's next full proof was refused with
`multiple_owners`. The other native suites that exercise this proof
(`native-ancestry-exit`, `native-admission-scheduled-churn`,
`fleet-health-metrics-native`, `native-proof-churn`, `project-native-proof`,
`fleet-defensive-os-native`) and the default-suite admission tests passed
(12 and 64 tests).

## Live after-measurement

Pending deploy. After the runtime carrying this change has run for at least ten
minutes, compare `clankie metrics --fleet` per-pane 5-minute proof attempts with
`raw/live-before.txt`. An idle bridge should show about one proof per new
connection: its startup, reconnects, and short-lived hook or catalog-report
processes. Also sample `native-process-proof --serve` CPU.

## Not established

- The Linux helper path was not run here; it uses the same `--birth` contract
  with kernel identities (inferred).
- The 5-second catalog checks themselves remain until VUH-2390; this change makes
  each one cheap but does not remove it.
