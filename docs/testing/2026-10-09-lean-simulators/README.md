# Lean fleet simulators (VUH-1988)

On 2026-10-09, two booted iOS 27 simulators held the 18-core, 128 GiB Mac at
load 340, and the fleet dropped to one simulator slot. This run measures what
one simulator costs and what the lean boot profile saves.

## Method

Every run used one leased device (`clankie simulator acquire`, iPhone 17,
iOS 27.0 build 24A5370g, previously booted), one at a time. A 5-second sampler
summed `%CPU` over that device's `launchd_sim` process tree (100% = one core)
and recorded the host's one-minute load. Other agents kept the Mac busy
throughout: background load1 was 10–50, so per-device CPU is the clean
measure and load is context.

- **Baseline:** the service's ordinary boot.
- **Lean A:** `simctl boot --disabledJob=…` for the Apple Intelligence, Siri,
  suggestions, News, Mail, Weather, Tips, indexing and media-analysis jobs.
- **Lean B:** Lean A plus `mlhostd`, `amsengagementd` and `PosterBoard`. This is
  the shipped `leanSimulatorJobs`.

The cold-boot window covers the first 5 minutes after boot was submitted. Idle
is the next 5 minutes (baseline: minutes 10–15) with nothing launched.

## Results

| Run      | Boot CPU mean | Boot CPU median | Boot CPU peak | Peak load1 | Idle CPU mean | Idle median |
| -------- | ------------- | --------------- | ------------- | ---------- | ------------- | ----------- |
| Baseline | 378%          | 177%            | 1563%         | 168        | 4.6%          | 0.4%        |
| Lean A   | 318%          | 191%            | 1479%         | 183        | not measured  |             |
| Lean B   | 315%          | 71%             | 1496%         | 200        | 21.8%         | 0.5%        |

Mean boot CPU per minute after submission:

| Run      | 0–1 min | 1–2 | 2–3 | 3–4 | 4–5 |
| -------- | ------- | --- | --- | --- | --- |
| Baseline | 964%    | 864 | 177 | 43  | 1   |
| Lean A   | 858%    | 668 | 155 | 84  | 1   |
| Lean B   | 1014%   | 568 | 23  | 26  | 12  |

Lean B uses about 20% fewer CPU-seconds over the boot (≈990 against ≈1230
core-seconds) and finishes its burst a minute sooner. It does not lower the
first minute's peak. That peak comes from SpringBoard's first render of the
wallpaper gallery: about a dozen poster extensions (Mercury, Pride,
Kaleidoscope, Gradient, Unity and others), plus widgets. They still render
with `PosterBoard` disabled, and no launchd label covers them. Lean B's idle
mean comes from one `mlhostd` spike that ran despite its disabled label (an
XPC-launched instance). Its median idle stays at 0.5%.

Kernel footprint of the idle device was 31.5 GB at baseline and 29.0 GB lean.
Other seats' iOS 27 iPhones running their app under an XCUITest driver held
1.5–2.1 cores steady at 35.7 GB and 36.9 GB footprint (about 34 GiB).

Every disabled daemon stayed off inside the lean device. The home screen
(wallpaper, Maps and Calendar widgets, icons, dock) was identical before and
after. `simctl boot` accepts unknown `--disabledJob` labels (exit 0), so one
list serves both the iOS 26.5 and iOS 27 runtimes.

## Two simulators

On CPU, two simulators fit within the 1.5 load guard (27 on 18 cores): lean
ones idle at under a quarter core, and one with an app under test holds about
two cores. Two **concurrent boots** do not:
each boot alone pushed load1 to 170–200 for about two minutes, and two
overlapping boots reproduce the original load 340. The one-minute load average
lags a boot's burst, so the pressure guard alone can admit a second boot
before load rises.

The governor therefore refuses a new simulator admission for three minutes
after the previous one (`simulatorBootSettleMs`), reported as `pressure`. With
boots staggered, two simulator slots fit this Mac's CPU and load guard.

Memory is tighter. Two simulators in use take about 69 GiB of kernel
footprint. That is more than half of 128 GiB, and the four heavy slots are also
sized at 24 GiB each. Automatic simulator capacity uses the in-use cost
(34 GiB, two cores) against half the machine:
`max(1, min(floor(cores/2/2), floor(RAM_GiB/2/34)))`. That is one on this Mac:
memory binds, while CPU alone would allow four. An owner who accepts the memory
risk can set `--simulator-slots 2`; the 4 GiB available-memory guard still
refuses new admissions when memory runs short. An explicit owner value always
wins, and this Mac's stored policy is `1`.
