# VUH-2102 CI pressure correction

Tracks: https://linear.app/vuhlp/issue/VUH-2102

Official v0.4.4 CI run [38131786566](https://github.com/Volpestyle/clankie/actions/runs/38131786566)
failed the scoped-check fixture both in the full suite and isolated rerun on
`176724d07`. Each timeout happened before the full holder wrote its startup marker.
The original failure is retained; the log does not identify which native pressure
guard refused that holder.

The test already uses its own registry. It now supplies the calm pressure needed
for its full-budget saturation scenario: load/CPU zero, 65,536 MiB available memory.
These are controlled fixture inputs, not measurements of the CI machine. The
inflated `maxLoadRatio: 16` override is removed. Production policy is unchanged.
Real native runners, all five real formatter/linter command forms, the held full
permit, queued follower, file scope and interruption assertions remain intact.

Focused verification on fetched main `c123cf488c85ed579291ea1563e791e55670b444`:
`clankie heavy -- pnpm exec vitest run packages/fleet-resources/test/scoped-code-check.integration.test.ts`
passed 2/2. Every actual scoped command finished with one full permit held and
one full follower queued. Scoped formatting passed. Integration's exact-tree gate
is the landing authority; no duplicate local root gate was run. A fresh official
CI run is still required after landing, and Juno owns that dispatch.
