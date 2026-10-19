# Simulator runaway before the idle deadline (VUH-2353)

On 2026-10-17, during VUH-1569, a leased iPhone 17 Pro on iOS 27.0
(`ECF31A58-614F-40A7-87C9-914A4930D974`) was sampled at 920% CPU and 36.0 GiB
kernel footprint. The sample came 145 seconds after the lease's last touch,
with no capture driver started. This run measures the same device on leases
taken by this worker.

## Cause

Every boot of this device ran two bursts. Both were dominated by PosterBoard's
wallpaper poster extensions. Neither was a sustained runaway.

1. **Cold boot (0–80 s).** About 15 cores for 25 seconds, then 3–5 cores
   while News, Calendar, Mail, Screen Time, Shortcuts and companion services
   started.
2. **Second poster render (about 150–185 s).** PosterBoard relaunched about a
   dozen poster extensions (Mercury, Gradient, Kaleidoscope, Rhizome, Pride,
   Aegir, Unity2025, Extragalactic, Photos, Weather). They ran at 10–12 cores
   for about 25 seconds. Footprint rose by 7.6–8.4 GiB to a 33.6–35.3 GiB
   peak, then returned to 26–28 GiB when they exited.

After the second render, the untouched device stayed at a 0.5–1% median. Its
largest spikes reached 1.3 cores (`AuthenticationServicesAgent`, managed-config
subscribers, `mlhostd`) and lasted 5–10 seconds. Steady footprint was
27.6–27.9 GiB across 234–236 processes.

| Boot             | Lease      | Burst 1 peak               | Burst 2 window | Burst 2 peak CPU | Peak footprint      | Peak load1 | Settled footprint |
| ---------------- | ---------- | -------------------------- | -------------- | ---------------: | ------------------- | ---------: | ----------------: |
| Run 1, 17:14:13Z | `4814c8d2` | 1534% (first ~22 s missed) | +157–182 s     |            1076% | 35.25 GiB at +177 s |       37.2 |         27.58 GiB |
| Run 2, 17:24:38Z | `805bc5ca` | 1537% at +24 s             | +147–172 s     |            1172% | 33.64 GiB at +167 s |       30.8 |         27.87 GiB |

Run 2 used 767 core-seconds in its first seven minutes. Poster extensions
account for 227 of them (30%), and `diagnosticd` and SpringBoard follow. Run 1's
sampler crashed on its first interval and restarted about 22 seconds after
boot, so it misses the start of the cold-boot burst.

The incident's 920% and 36.0 GiB at +145 s fall in the second render's window
and match its size. That lease's boot time was not recorded. The match is an
inference from two controlled boots, not a measurement of the incident itself.
The 2026-10-17 host was already at load/core 3.46 with two full heavy jobs held.
On that host a fixed burst of work would run for longer and keep heavy
admission waiting until it ended. On a quieter host, here load1 3–8 before
boot, each burst lasted about half a minute.

These runs did not reproduce any sustained CPU after the second render.
VUH-1988's daemons pegged near 100% and respawning were not seen on an idle
device here. The device runs about 260 process births in its first seven
minutes, most of them during the two bursts.

## Policy

- **Boot bursts are protected.** A lease is never reclaimed within
  `simulatorBootSettleMs` (three minutes) of its creation. Both measured bursts
  fall inside that window, and killing a boot would waste its cost and the
  holder's work. Heavy jobs wait out the burst under the existing load guard.
  The governor's existing three-minute boot spacing already keeps a second
  simulator from starting during either burst.
- **Settled runaways are reclaimed only when the host is exhausted.** After
  its boot settles, a leased device is shut down early (reason `runaway`) only
  when all three hold for two minutes:
  - the device's own census shows at least four cores (`RUNAWAY_CPU_PERCENT`);
  - its holder has not touched or reacquired the lease;
  - the host is refused for `load` or `memory`.

  A touch, a calm or unavailable usage sample, a healthy host or an
  unavailable probe restarts the window. Four cores for two minutes is 480
  core-seconds, about twice the largest measured poster burst, so an ordinary
  boot cannot trigger it. An app under XCUITest held 1.5–2.1 cores in
  VUH-1988.

- **Seat isolation.** Only leased devices are judged, through the lease's
  exact UDID. External devices are still only reported. Settlement uses the
  normal shutdown path and keeps the device.
- **Settlement is recorded.** Each lease end appends `simulator-settled.jsonl`
  beside the lease journal. It records lease, seat, holder, UDID, creation,
  last touch and one of `released`, `idle`, `owner_exited`,
  `reservation_stale`, `acquire_aborted`, `device_missing` or `runaway`. The
  holder's next touch, verify or release on a settled `idle`, `runaway` or
  `owner_exited` lease says why it is gone. A shutdown still in flight across a
  service restart settles without a receipt, because the reason is held in
  memory.

The runaway guard is a backstop for a condition these runs did not reproduce.
It has been proven only against the fixture census in
`simulators.integration.test.ts`, not against a live runaway.

## Release and idle expiry

Both paths used the exact device above. No global simulator command was run.
Status reads do not touch a lease.

**Idle expiry** (`expiry-timeline.log`, lease `4814c8d2`): acquired 17:14:13Z,
`lastUsedAtMs` 1792430054306 (17:14:14.3Z), never touched or released. The
device was `Booted` with the lease `booted` at 17:24:18Z. At 17:24:23Z it was
`Shutdown` with no lease, 600–609 seconds after the last use and within one
five-second manager tick.

**Explicit release** (`release-timeline.log`, lease `805bc5ca`): touched at
17:26:50Z, 17:28:51Z and 17:30:51Z, which put its idle deadline at 17:40:51Z.
`release` was sent at 17:31:42Z with the device `Booted` and answered
`released`. At 17:31:46Z the device was `Shutdown` and status listed no lease,
nine minutes before the idle deadline.

These live runs predate the settlement receipt, so they are distinguished by
these timelines. The receipt is proven by the integration test, which settles
three leases as `runaway`, `released` and `idle` in order.

## Files

- `sample.py`: the bounded read-only sampler. It runs the fleet native
  helper's `simulator-usage` every five seconds for one UDID and records
  per-executable interval CPU and footprint, births, host load1 and
  `memory_pressure -Q` free percentage.
- [`run1.jsonl`](clankie://evidence/sha256/3143711a2c4e5d2f122a1834a1defeaca08316e296320c95047e7c9cd46ff231): run 1 from about +22 s. It ran 900 seconds, so it also covers
  run 2's boot, from +632 s on its own clock. [`run2.jsonl`](clankie://evidence/sha256/cf038afe230e8c78ff638b1c30d64b6ebd8a1640f50ad4e540f098f12f7861b3): run 2 from 6.4 s
  after its lease.
- `expiry-timeline.log`, `release-timeline.log`: lease and native state, five
  seconds apart.

Load and free memory are shared-machine measurements. Per-device CPU and
footprint come from the device's own `launchd_sim` tree.
