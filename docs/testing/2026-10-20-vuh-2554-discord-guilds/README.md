# VUH-2554: independent Discord guild settings

Tracks: https://linear.app/vuhlp/issue/VUH-2554

Core proof uses disposable settings stores and loopback Discord REST/body/service
fixtures. No live Discord settings, messages, deployment or runtime restart.

- Eight focused files pass: 63 tests. Includes migration/reload/environment
  round-trip, two-guild role and fleet gates, independent tracking levels and
  durable deliveries, owner-only audiences, settings API revision conflicts,
  real CLI and TUI overlays, and native gateway permission evidence.
- Protocol typecheck passes. TUI source and all four test compiler shards pass.
- Root landing gate and integration receipt are reported on the issue after
  completion; this focused run does not substitute for that gate.

The app proof follows after core lands. iPhone and Mac stills remain pending.
A group still retains one Admin webhook; new automatic group rooms use the
first enabled Admin guild. Participant projections send to each enabled guild's
own channel. VUH-2531's two-way forum work tracker is outside this change.
