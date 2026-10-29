# Simulator observation backlog — VUH-2969 follow-up

Baseline: `0c1613e61af1db7898a2332fc3fbabfac09f57af`.

Timer and seat-census ticks each queued a complete native activity observation
inside the simulator mutation queue. Slow reads therefore delayed release, and
overlapping ticks accumulated additional observation rounds ahead of it. The
repair coalesces pending rounds and reads native activity outside that queue.
Applying a result rechecks the reservation, current policy and live process
births. Native simulator effects remain serialized.

Raw captures are in `release-backlog-captures.tar` in
[the evidence manifest](./evidence.json).

- `release-red-booted.log`: both new regressions fail on baseline production
  source. A paused native read makes HTTP release of a fully booted fixture
  return `held`; 21 overlapping ticks perform 21 native observation rounds.
- `release-green-final.log`: 57/57 pass across simulator and resource-wait
  integration suites, including both regressions and existing idle-expiry,
  process-exit and ownership controls. Release completes while the read remains
  paused; its late result cannot restore the reservation.
- Juno's copied receipts show her booted iPad release returning `held` and a
  later acquire returning the same still-held lease. Her durable settlement
  records `released` at 04:50:13.327Z, about three minutes after her request.
  This proves eventual release, rather than a permanently lost release intent.
  Production lacks per-tick timing, so the exact queue depth is unmeasured.
- The later phone ticket waited for this worker's held DF8065BF device, despite
  two free simulator slots. Waiting rather than cloning a matching busy device
  is explicit existing selection policy from `f00971b87c`; releasing only this
  worker's proof lease let Juno proceed. That wait is separate from the backlog.

Checks ran through `clankie heavy` with a scratch HOME. Native harness and
simctl fixtures are surrogates; HTTP, process births, durable governor state and
native-effect receipts are real. No Juno lease or device was modified. No service
restart was performed by this worker. Deployed queue retention and prompt-idle
expiry remain open acceptance for VUH-2969 after the lead deploys this follow-up.
