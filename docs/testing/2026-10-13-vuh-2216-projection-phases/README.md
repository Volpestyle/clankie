# VUH-2216: native fleet projection phase timings

Timing-only instrumentation follows the cleared captain import, observeFleet and observeFleetProjection sites. It adds one content-free structured `fleet.projection.timings` service-log record when an actual refresh completes or fails. The shared display refresh, caching, native transport deadlines, admission reads, authority checks, mutation order and returned values remain unchanged. No new native observations or settings are added.

The record includes total duration and named phase wall durations plus maximum individual awaits. Local and PC census spans use the existing pending callback; it now carries fulfilled/rejected outcome before the existing fallback catches. Goal/status includes separately timed subagents, remote goals and native status. Capabilities, waiting notices, activity, routing/catalog, Git/telemetry and final issue enrichment have separate spans. Nested/parallel intervals are measured as a wall-time union, not summed; parent phases overlap children. No identities, paths, commands, payloads or exception messages enter diagnostics.

The real-file logging integration reads parallel files and a missing path through the helper, checks unchanged returned values and exception identity, and verifies the persisted structured log contains phase/outcome/durations without private content or paths. Existing restart, remote-goal and census checks cover the instrumented consumers. Governed focused checks passed: 26 cases across four files, followed by the final census/logging pair after the last span adjustment. Formatting, lint and docs checks (745 Markdown files / ten generated pages) passed. The integrator exact-tree gate passed: 340 files / 3,181 tests, with 49 skipped cases. Source `7e122dc3e` landed as `89a844b6d` and the lead deployed it at 15:53Z.

Read info-level `fleet.projection.timings` records from the launcher service log (default `~/.local/state/clankie/clankie.log`, state-home environment overrides preserved). After lead deployment, capture one five-minute fresh-native roster/health window and align the completed phase records with that boot. Do not change a suspected phase until the deployed timings establish its cause; any fix is a separate issue.

The deployed five-minute window ran through `clankie heavy --server` from 15:55:27 to 16:00:29Z on unchanged PID 99241 / boot 2a3d123f-c751-49af-b3cb-2048a3bec471. All 299 fresh-native health responses retained that identity: p50/p95/max 0.955/3.046/545.206 ms, zero errors. The 23 actual roster responses had p50/p95/max 3914/4846/6040 ms, zero errors at the diagnostic 8 s deadline, and only five below 1 s. Production deadlines were unchanged. Load1 was 7.28 initially and 5.44 at the last sample. The full production canary passed with 31 samples, health p95 2.078 ms and CPU mean 23.23%. Intermittent health outliers and the roster target remain open.

The 44 completed projection spans name issue enrichment and capability reads as the dominant phases:

| Phase                | p50 ms | p95 ms | max ms |
| -------------------- | -----: | -----: | -----: |
| Issue enrichment     |   2145 |   2340 |   5800 |
| Capability           |   1239 |   2172 |   2453 |
| Census (parent)      |    112 |    784 |    801 |
| Local census         |    111 |    784 |    801 |
| PC fleet             |     57 |    128 |    371 |
| Goal/status (parent) |    228 |    765 |   2385 |
| Remote goals         |  0.044 |    540 |    613 |
| Native status        |    209 |    221 |   1849 |
| Activity             |      6 |     32 |     71 |
| Git enrichment       |     18 |     20 |     24 |
| Settings/binding     |      1 |      3 |      5 |

Total projection p50/p95/max was 4198/5853/7955 ms. Parent and child spans overlap; do not add them. These are completions in the window, not request correlation. The unnamed other-fleet transport rejected in all 44 records (p95 112 ms); rejection is transport outcome, not authority proof.

Source confirms the capability reads run serially. [VUH-2237](https://linear.app/vuhlp/issue/VUH-2237/roster-serializes-independent-per-seat-capability-observations-adding) takes a bounded concurrency-of-four fix while preserving fresh reads, original seat order and ordered waiting-notice writes. Issue enrichment still combines fresh attribution and issue-keeper observation; the next timing-only sub-spans will distinguish those costs before changing either authority path. The manifest retains the raw probe, sanitized timings, scripts, runtime identities, full canary and exact gate evidence.
