# VUH-2164: schedule native queue proofs without competing suite forks

The failed production batch `02998d18-d96c-4f57-a73e-4509b1407bbf` timed out the unrelated-main-move scenario at its existing 30-second deadline. Its retained logs show the first unchanged-input revalidation succeeded and the second affected-input revalidation correctly requested another gate; the third gate had started when the deadline expired.

A real subprocess profile on fetched main `1b70207d8` records 165 Git processes (4.004 summed seconds) and eight pnpm install/gate/revalidation processes (4.468 summed seconds). The case runs three composed batches serially, while the old configuration permits other suite forks to compete for CPU. Move the entire native local integration file into the existing serial integration project alongside the remote integration file. Each file still has a separate fork; assertions, test deadlines, selected cases and retry policy stay unchanged.

Focused checks use `clankie heavy -- pnpm exec vitest run` with only the two reported cases selected. Before changes, integration passed in 8.705s and canary in 4.780s. After changes, integration passed in 12.884s and canary in 5.739s. The post-change report confirms the parallel canary file finished before the serial integration case began. These are different host conditions, not a claimed speedup. Two existing real HTTP/process pressure scenarios also pass. Explicit touched-file formatting and lint pass.

The archive retains the historical failures, first focused passes, subprocess profile, changed configuration/source, post-change reports and a separately labelled post-check host-load observation. An initial profiler wrapper lost Node's custom promisify contract and failed before fixture setup; that instrumentation error and the corrected passing profile are both retained. It is not a product failure.

[Evidence archive](clankie://evidence/sha256/be2f002d0549a78b2501e9818d17507e85b5ab52efa63b5e0ce849df8464b834).

Exact-tree merge-queue proof and landing are pending. No full-suite loops or evals ran.
