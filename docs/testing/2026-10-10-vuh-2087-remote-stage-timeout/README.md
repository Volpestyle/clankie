# VUH-2087 remote preparation deadline

Candidate based on fetched origin/main `2c811fdb65a44b55c79c285a35de136317d7c38e`.
Remote placement/staging has a shared 120-second deadline; cleanup has a separate
10-second deadline. A timeout records its phase and selected machine, plus any
cleanup failure, and falls back to the normal local gate. Cancellation stops only
the current call's SSH child (TERM, then KILL after one second).

Focused checks through `clankie heavy` passed:

- `pnpm exec vitest run apps/clankie/test/integrate-remote.integration.test.ts`: 5/5.
- `pnpm --filter @clankie/clankie typecheck`: exit 0.

The existing real Git/pnpm/transport integration fixture proves remote success,
unavailable-machine fallback and Darwin regating. New placement/stage cases use
actual connected children that ignore TERM. Both record deadline fallback, run
the local gate successfully, stop those children and complete a later queued
request. Stage also proves cleanup timeout evidence. Production PC behavior was
not modified or exercised: the existing service-owned PID 46888 was only read.

[Proof JSON and captured check output](https://uploads.linear.app/75f1d1f0-542b-4095-9967-fd7b27093472/c0d62fc2-8f5e-408a-b785-ce231f4a750f/5ef35882-80b7-4903-96da-af34dbd8837d)
is attached to [VUH-2087](https://linear.app/vuhlp/issue/VUH-2087/remote-integration-placement-can-hang-indefinitely-and-block-the).
Tiny raw logs stay in ignored `.local/vuh-2087-evidence`; evidence-store archive
selection excludes non-media files below 16 KiB. Landing is separately attested
by the integrator's root gate and push receipt. No evals run.
