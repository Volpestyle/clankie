# ADR 0249: Simulator leases answer promptly and name their holders

Status: Accepted (VUH-1816, 2026-10-07; decided by the implementing agent as
its brief asked, for James's review). Amends the simulator
lease contract in [`packages/fleet-resources`](../../packages/fleet-resources/README.md),
which no earlier ADR recorded.

## Context

On 2026-10-07 three app lanes could not capture screenshots because
`clankie simulator acquire` failed without saying why:

1. Two simulators booted by hand with `simctl`, outside any lease, filled the
   simulator limit. Every acquire waited in the governor's queue until the
   CLI's 120-second timeout, and status said only `externalActive: 2`.
2. During a deploy restart the governor's shutdown aborted a queued acquire,
   and the route reported every exception as `owner_unavailable`.
3. An acquire for `iPad-Air-11-inch-M3` created a fresh device although an
   idle M4 of the same screen existed. A fresh device's first boot outlasted the
   CLI timeout.
4. The service treated the HTTP disconnect as lost authority. A CLI timeout
   during create or boot left a lease that held a slot but was never booted, or
   one that appeared later in `boot-submitted` with nobody waiting for it.

Simulator tickets also shared the heavy-command FIFO, so a lane could wait
behind builds with nothing telling it so.

## Decision

**Acquire never outlives its caller silently.** It answers within about 20
seconds with one of:

- `acquired`: the lease's device is booted.
- `booting`: the service admitted the lease and is creating or booting its
  device. The service owns that work; the caller's connection is not
  authority. Acquire is idempotent per seat, so polling it returns the same
  lease, and `--wait SECONDS` on the CLI polls with progress on stderr.
- `waiting`: no slot is free. `blockers` names simulator leases by seat and
  device, devices booted outside leases by name, UDID and the seats whose
  processes use them, heavy commands by seat and PID, or machine pressure.
  Simulator requests do not queue; nothing is left behind when the caller
  stops polling. A free slot goes to whoever asks first.
- `rejected` with the real cause: `owner_unavailable` only when the seat's
  live native occupant could not be proven, `service_restarting` (HTTP 503)
  while the service starts or stops, `authorization_revoked`,
  `simulators_disabled`, `seat_not_local`, `device_unavailable` with
  `alternatives`, `inventory_unavailable` or `internal_error`.

The owner's bearer is still checked before every native effect. A lease whose
boot failed or died with the service is resumed by the same seat's next
acquire, and a reservation that never submitted a native effect is released
after five minutes.

**Existing devices come first.** Acquire leases an idle (Shutdown, available,
unleased) device of the exact type and runtime, then one of the same family
(the type without its chip suffix, so an M4 stands in for a missing M3) unless
`exact` is set, then creates the exact type if it is installed. Otherwise it
refuses with the close devices and types it found. Cleanup deletes only devices
the lease created (`origin: created`); an existing device is shut down and kept.

**Devices booted outside leases are named, never reclaimed.** `clankie
simulator status`, `clankie doctor` and every `waiting` answer list them. The
native helper finds this user's processes whose arguments contain the device's
UDID (or its name, when no other device shares it) and maps them to the seat
whose pane started them; arguments never leave the helper. When a seat is
found, its lead is told once through the fleet alert channel. A seat brings
its own device under a lease with `acquire {"seatId", "deviceId"}`; releasing
that lease shuts the device down. Clankie never shuts down or deletes a device
it did not lease, because idleness cannot be proven from outside and a lane
may be mid-capture.

## Alternatives

- **Keep a server-side queue with a longer CLI timeout.** Any finite timeout
  can still strand a ticket or a boot, and a queue position says nothing about
  who holds the slots.
- **Adopt every external device automatically into the seat that uses it.**
  Attribution depends on a live process naming the device; a device booted by
  a short `simctl boot` has none. Silent adoption would also make a later
  release shut down a device the seat thought was its own.
- **Reclaim idle external devices after a notice.** Rejected: a device can
  look idle while a lane reads its screen, and a wrong shutdown loses work.

## Consequences

- Agents boot simulators only through `clankie simulator acquire`; the shipped
  `fleet-resources` skill and the local hire brief say so.
- Fairness between waiting lanes is first-come at the moment a slot frees,
  not FIFO.
- Attribution is best-effort. A device with no live process naming it is
  listed as unattributed, and its owner is found by asking the fleet.
- The CLI and the service must both be updated for the new outcomes; an older
  CLI rejects the new response shapes.
