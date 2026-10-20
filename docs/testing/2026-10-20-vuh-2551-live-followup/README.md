# VUH-2551 live follow-up, 2026-10-20 15:37Z

Tracks: https://linear.app/vuhlp/issue/VUH-2551

**No second fix is justified yet.** The cache's deployed canary was 35.75%
against 34.62% before (lead's measurement). Read-only observation of live PID
79170 confirms 35.88% over 120.26 seconds, with load1 5.22–9.87. No live signal,
inspector attachment, restart or state edit was performed.

Three independent `sample 79170 10` captures consistently identify **V8 major
GC/allocation as the largest named runnable native cost**, alongside UTF-16 JSON
parsing and megamorphic property access. `ConcurrentMarking::RunMajor` has
342/328/219 collapsed leaf samples in captures 1/2/3, with further heap traversal,
sweeping and main-thread GC work. Main event-loop `kevent` occupies
5607/7005, 5800/6996 and 5840/6996 samples respectively. These are wall-stack
observations, not percentages of process CPU. JIT frames remain anonymous;
**the allocating JavaScript caller has not been uniquely identified**.

## Suspect results

| Suspect                              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Verdict                                                                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings/authority reads             | Native async file callbacks remain; lsof caught settings.json (70,352 bytes). Private exact-settings replay through SettingsStore.load (`packages/settings/src/store.ts:48`, parse :131), 6,040 calls / 30.15 seconds, used 7.64% CPU at load1 5.76–7.08.                                                                                                                                                                                                             | Confirmed cost; even 200 loads/sec did not reproduce 35.88%. Actual live call rate is unknown, so not eliminated.                                                       |
| Roster/native transcript telemetry   | lsof caught 3 active Codex journals (2.85/43.65/49.35 MB). They changed 2/6/3 times in 20 seconds. Private bounded header + 2 MiB tail copies, replayed at 1 roster pass/sec with those observed stamp changes, used 4.90% CPU / 30.99 seconds at load1 6.00–6.71 (93 seat reads, 18 invalidations). Named CPU profile: nativeSnapshot :375 → parseSeatTelemetry :265 / nativeActivity :48 → parseHerdrSeatTranscript (`packages/agent-transcript/src/index.ts:618`). | Confirmed repeated parse/stringify work, insufficient by itself in this captured three-seat workload. RPC/event processing and other projection work were not replayed. |
| Integration/reclamation/holds        | Live file callback mix now includes AfterStat/structuredClone, consistent with the cache. No repeating durable write/fsync hot stack in these three captures. Sweep is every five minutes (`integrate.ts:1003`); per-batch lock is :797.                                                                                                                                                                                                                              | Not dominant during the captures; a sweep outside them is not eliminated.                                                                                               |
| Resource arbitration                 | Arbiter is 1 Hz (`fleet-resource-runtime.ts:483`, `packages/fleet-resources/src/governor.ts:723`); metadata/read callbacks overlap this code and the record cache.                                                                                                                                                                                                                                                                                                    | Native stacks do not distinguish these stat/read callers; not confirmed as dominant.                                                                                    |
| Linear recovery/conversation journal | `freshLinearEvents` (`captain/conversations/linear-wakes.ts:103`) filters ConversationJournal's resident events. 24 live journals total 8.62 MiB, largest 4.66 MiB, all within the 32 MiB cache. No dominant synchronous journal-read stack in these captures.                                                                                                                                                                                                        | Cache-size thrashing explanation eliminated for this inventory; filtering CPU remains unquantified.                                                                     |
| Presence                             | No distinct dominant timer/presence stack resolved.                                                                                                                                                                                                                                                                                                                                                                                                                   | Unproven; not claimed eliminated.                                                                                                                                       |

The private reader modules are byte-identical between worker HEAD and deployed
3f05e78b3 (`git diff` empty for seat-telemetry.ts and settings/store.ts).
The probe used `clankie heavy -- node --cpu-prof ... probe.ts`, exited normally,
and its copied private settings/transcripts were deleted. The profile includes
startup and both 30-second reader phases; per-phase CPU is measured separately
with process.cpuUsage. This is a private reader replay, **not a complete service
or native RPC traffic replay**. Private data contents are not archived.

## Decision before another fix

The previous synthetic-history proof did not predict live CPU; repeating that
mistake with the telemetry/settings probes would be unjustified. Current result:
GC/allocation is the dominant named native category; its dominant JS producer is
still unknown. No product code or tests were changed in this follow-up.

Recommended next evidence is a true service JS CPU profile on the next already
planned lifecycle, using the shipped CLANKIE_CPU_PROFILE_DIR opt-in in the actual
launcher environment and reading the file after its next planned graceful exit.
That requires no extra restart or live inspector attachment. The lead owns that
lifecycle decision. A fuller private replay needs actual request/native-event
rates, which these live native stacks and three observed journals do not provide.
