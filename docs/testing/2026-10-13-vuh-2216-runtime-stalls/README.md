# VUH-2216: runtime stalls

Read-only native profiling of PID 98101 on `42070cda8` showed all four libuv filesystem workers unlinking during terminal isolation cleanup (09:50:37–09:50:53Z). Bulk recursive isolation, partial-removal fallback and regate cleanup ran inside the service; ordinary Git worktree removal already used a child.

The deletion fix moves recursive integrator/manual-cache deletion into an awaited child Node process. Ownership, terminal/retry, dirty-tree, inventory, live-cwd, symlink and error semantics remain. It landed from source `b5d81ff24749990aa8a716e0c4c28323931ba552` at main `6620a44839e20536c0dfeeb56c2f6f14cdb3bcea`, request `2080be79-e265-4dca-af7d-02ddb0470af3`: exact gate exit 0, 84 files/598 tests passed, one file/two tests skipped. Lead deployed it at 10:47Z.

## Measurement correction

The earlier generic-fetch probes reported health p95 400–1,077 ms, but those numbers are **transport-confounded**. The production sampler already avoids a known idle Node/Undici shared-socket delay by using fresh native HTTP. The same profiled PID 92871 actually passed a complete 31-sample production canary at 10:33Z, p95 2.14 ms. Do not claim a server-latency improvement by comparing pooled-fetch values with native HTTP. The native threadpool trace remains valid.

A corrected five-minute fresh-native probe on deployed `6620a4483` (PID 82951, one unchanged boot identity) measured health p50 **1.13 ms**, p95 **136.91 ms**, max **640.61 ms**, no errors. Roster: 26 calls, p50 **1,079.12 ms**, p95 **4,888.48 ms**, max **6,142.03 ms**, no timeouts. Load was 12.52 at the start and 14.52 at the end. This long probe used `clankie heavy --server`; its CPU observer briefly degraded/resumed, recorded in the log. The deployed runtime's official canary was still pressure-pending when captured; these observations are not a passed full canary.

## Profile and roster fix

The lead-enabled CPU profile covers 10:24–10:47Z, including the 10:41 deletion burst: 1,367 seconds/972,327 samples. `reportSummaries` → `inboundReports` accounted for **90.14 s inclusive**, with a longest consecutive sampled stack run of **115 ms**. It validates full retained receipts before filtering per-seat/read state and then drops message payloads for metadata cards. GC accounted for 28.76 s. Local tracker `parseStore` accounted for 51.28 s; tracked separately under [VUH-2219](https://linear.app/vuhlp/issue/VUH-2219/local-tracker-repeatedly-parses-and-audits-the-entire-persisted-store). Sample runs are stack/wall-time observations, not an event-loop timer.

The follow-up projects and validates the existing metadata contract directly from validated in-memory receipts, filtering sender, read state and time before projection. Full receipt validation occurs before admission and on restoration; full report reads/acknowledgment still use the complete validation path. No new cache, ownership relaxation, acknowledgment, timeout or admission change.

A read-only copy of the real 10.29 MB inbox held **3,210 retained/697 unread** reports. Across 30 iterations, old projection p95 was **12.37 ms**, metadata projection p95 **0.97 ms**, with identical output. The live inbox was never modified by this proof. This measures projection cost, not full live roster latency.

Governed checks: 21 report CLI/recovery integration cases passed; the final 585-report regression passed, including metadata-only output, exact sender/time filters, unchanged retained bytes, rejection of malformed admission and persisted history, full payload retrieval and offered-only acknowledgment. Formatting, lint and the complete service typecheck (source plus all 13 test groups, 153.23 s) passed. The first regression expectation omitted the restored `stage` field; corrected before passing. The integrator supplies the exact-tree landing gate.

**Open acceptance:** the metadata follow-up's landing/deployment, a full post-fix busy-machine canary, and live roster calls under one second. Deploy and issue closure belong to the lead. No restart or inspector was initiated by this worker.

Protected CPU profile: `clankie://evidence/sha256/b4f7545c891ecd4ed6b273a5ade998ca99accd1fd99f77c1671b8823dc50a2a6`. Corrected native measurements, real-inbox parity, and regression evidence: `clankie://evidence/sha256/e66c9377c0925b605c4f2de825239e45449b6ef5f78ae4bcc70ed2ae296f9e62`. Earlier native samples remain in `clankie://evidence/sha256/aee7f4ab8e8343d9af7f188c2df28abaaee245621f7b38969d67e9bc2539108b`; its pooled-fetch timings are superseded as described above.
