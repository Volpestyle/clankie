# VUH-1948: pending OpenCode follow-up

The pending SSH reply check performed a redundant resume before the message whose
reply it delayed. The preceding lifecycle case already covers native resume and
history reuse. Use the initial hire followed by one message, retaining the real
4.25-second Herdr reply delay, original helper and SSH forward, matching consumed
working receipt and single delivery. Assert both transports exist before checking
that they remain open. No timeout, retry or production ownership check changed.

Race the report barrier against the native send result. If the controller cannot
send, expose its actual receipt instead of waiting for a report that cannot arrive.
The existing revision-retirement case captures the message tool before advancing
the real worker fleet revision, then proves its failed send ends that report wait,
with no new layout or message. Existing eviction and history assertions remain.
This proves the failure path; the cause of the historical retirement is unproven.

Rook measured the unchanged selected case at 9.504 seconds and the candidate at
7.243 seconds, with the same intentional delay (4251.8 ms). Instrumented unchanged
stages attributed about 2.56 seconds and 4923 helper RPCs to the redundant resume.
These observations were not a paired equal-load benchmark and do not prove the
historical 30-second timeout resolved. The TCP buffering experiment did not improve
timing and was discarded.

Verification results and raw captures are retained in the evidence manifest.

Three simultaneous complete lifecycle-file passes, under one `clankie heavy`
permit with `VITEST_MAX_WORKERS=1` per process, passed all 21 cases each (exits 0).
Pending reply durations: 8.890 / 8.857 / 8.807 seconds. The measured intentional
delays were 4250.7 / 4250.2 / 4250.9 ms. All three include the revision-retirement
regression. Its receipt is `undelivered/unavailable` with detail
`Remote native fleet revision is retired`; the report race surfaces that receipt,
without redispatch, while native history stays readable. The focused retirement
pass also passed (5.532 seconds); an earlier attempt failed an incorrect `isError`
assertion, corrected to the tool's structured outcome and retained as a failed run.

The root landing gate uses its own changed selection against fetched `origin/main`.
Its checked revisions and final result are attached to the
[VUH-1948 issue](https://linear.app/vuhlp/issue/VUH-1948), separately from these
focused results. These are integration fixtures at OS/Herdr and SDK boundaries,
not a live provider-backed OpenCode run.
