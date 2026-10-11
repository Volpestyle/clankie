# Landing wait conditions (VUH-1981)

Tracks: https://linear.app/vuhlp/issue/VUH-1981

Fetched baseline: `2c811fdb65a44b55c79c285a35de136317d7c38e`.

All four reported cases still exist. Three mechanisms were already fixed:

- Discord CLI awaits real subprocess completion without the former 15-second kill (`891029681`).
- Fleet CLI waits for its owned receipt or child exit without the former eight-second readiness clock; private admission fixtures use calm pressure (`891029681`, `77d93024c`, also VUH-1956).
- Lead-historical uses a small replay repository instead of archiving the full checkout for every fixture (`4628908c9`, `d9e943da3`, VUH-2056). The test executes inert transport fixtures, not Docker, grading, dependencies or model evals.

Runtime-health still raced: its receiver writes an acknowledgment before the
observer's awaited delivery settles and publishes the new observation. The test
now waits for both an acknowledged notice and the published accepted alarm.
Recovery waits for both boundaries too. The duplicate assertion waits for
another completed unhealthy observation instead of sleeping 500 milliseconds.
All assertions and existing timeout ceilings are unchanged; product code and
defaults are unchanged.

Verification: `clankie heavy -- pnpm exec vitest run` with all four named files:
exit `0`, four files / 41 tests passed, `36.55s`. The run began beside a real
admitted heavy job and two light jobs. Load averages were `34.45 / 16.70 / 19.12`
before, `25.80 / 17.00 / 19.10` after. Native evidence records CPU `298.8%`,
health latency `1135ms`, exactly two acknowledged notices (alarm and recovery),
and the final healthy accepted observation. Fixtures use temporary loopback
ports and an owned isolated Herdr namespace. No simulators or model evals ran.

`clankie heavy -- pnpm exec oxfmt` on the changed test: exit `0`.

[Verification capture](clankie://evidence/sha256/26a7024605fdd05a59752c68f0cc26c072b70c7561f1050ef7a8eefe152f3ed0)
contains all four source files, the diff, focused output, native delivery proof
and fleet load snapshots.

Per lead direction, integration's exact-tree root gate is authoritative; no
local duplicate root gate runs. Landing and closure remain pending.
