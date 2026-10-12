# VUH-2165: keep canary lineage independent of ambient machine pressure

Batch `0d2cbff3-2536-4af4-b2c4-745ac070332e` failed the canary scenario's existing eight-second observation wait, after 10.354 seconds overall. This was not a ten-second Vitest timeout: the case already has an explicit 30-second deadline. Its retained result was pending with one sample and an unavailable pressure notice. RuntimeCanary intentionally resets the observation window while external host pressure remains high, so a fixture expecting a pass cannot depend on a busy shared Mac clearing within eight seconds.

Supply explicit quiet external-host observations to this lineage scenario, as the dedicated canary process fixtures already do. The candidate CPU sampler, loopback health HTTP, failed canary, durable holds, authenticated owner CLI override, detached real release helper, archive/checksum cutover, runtime identities and subsequent deploy all remain real. Every assertion, policy window, sample interval, wait deadline and Vitest deadline is unchanged. Production pressure guards are unchanged.

The two reported cases pass after changes (canary 5.739s, integration 12.884s). Existing real HTTP/process scenarios prove a pressured candidate retains its hold and passes only after a fresh quiet window (3.432s), and measured quiet CPU permits a pass despite inflated historical load averages (1.995s). Formatting and lint of explicit touched files pass. These checks ran through `clankie heavy --`; no mock responses or evals were used.

[Evidence archive](clankie://evidence/sha256/be2f002d0549a78b2501e9818d17507e85b5ab52efa63b5e0ce849df8464b834) retains the historical failure, before/after reports, source diff and load observation. It also contains the separately explained VUH-2164 subprocess profiler setup error and corrected profile.

Exact-tree merge-queue proof and landing are pending.
