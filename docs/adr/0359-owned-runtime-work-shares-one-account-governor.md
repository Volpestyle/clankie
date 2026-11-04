# ADR 0359: Owned runtime work shares one account governor

Status: recorded existing practice for #344 (2026-11-04); no runtime or authority change.

## Context

The shipped fleet-resources skill requires a common governor, but did not link
the reasons for its build/server lanes, automation isolation or conservative
cleanup. Separate worktrees still run under one OS account and compete for the
same cores, memory, disk and simulator devices. A private HOME is not a private
machine. The earlier pressure gate could strand healthy work behind unmanaged
load; #599 removed it in favor of FIFO permits and bounded tool fan-out.

## Decision

- Owned builds, checks and runtimes use the account's canonical governor. A
  caller cannot create more capacity by changing HOME or state paths. Bounded
  full/light jobs and long-lived servers have separate lanes so a watch process
  does not occupy a build permit indefinitely.
- Tool thread caps constrain fan-out within a permit. The server supervisor
  samples CPU and repays bursts; degraded observation remains visible rather
  than pretending enforcement succeeded. Slots are admission; disk warnings
  are informational. The owner changes live limits through the settings API.
- A worker cleans up only its own exact processes. Same-user `pkill -f` or
  `killall` can match siblings; process names, age and a gone pane do not prove
  ownership. Retirement uses the controller's recorded process and lifecycle
  proof, not a raw-signal fallback. Uncertainty remains a refusal.
- Automated device pairings carry a unique run and bounded lifetime. Fixture
  services use test markers and private journals, and scratch service/relay
  proofs use one matching generated configuration with distinct ports. These
  isolate test state without evading the real worker governor or borrowing an
  owner's pairing, credentials or live service endpoints.
- Holder alerts name the permit owner and executable, not arguments. They
  identify long-held work for coordination; they do not authorize killing it.

## Evidence and limits

This records the implementation and shipped contract on main `c979eeaba`, not a
new performance experiment. [The resource contract](../../packages/fleet-resources/README.md)
and [admission reference](../../.agents/skills/fleet-resources/reference/admission.md)
retain the current lane sizes, server CPU sample period, 15-minute alert delay,
and disk thresholds. [Sizing](../../packages/fleet-resources/src/sizing.ts),
[the governor](../../packages/fleet-resources/src/governor.ts) and
[the server supervisor](../../packages/fleet-resources/src/server-cpu.py) are
executable evidence of enforcement; [scratch-stack](../../scripts/scratch-stack.mjs)
records the proof layout. The values are bounded defaults, not demonstrated
optimal settings. [ADR 0249](0249-simulator-leases-answer-promptly-and-name-their-holders.md)
records the separate simulator problem, and
[ADR 0293](0293-a-seat-is-sized-by-its-work-not-its-window.md) records why waits
belong outside model turns. No claim is made that same-user processes are isolated
from a malicious sibling or that sampled CPU is a hard instantaneous ceiling.

## Revisit when

- Retained queue-wait measurements show starvation or excessive wait with idle
  capacity, or a new tool escapes its permit's fan-out limits.
- Machine sizes, simulator footprint or server workloads change enough that the
  current ratios no longer fit; measure the new workload before changing defaults.
- Alerts repeatedly name healthy work without an actionable decision, or disk
  warnings miss real exhaustion; tune them from observed outcomes.
- A platform can enforce equivalent ownership and resource limits differently.
  Preserve the canonical registry and exact-process cleanup proof when doing so.
