# Verify #101 against main (`9a9a4a3`)

**Fixed through `clankie transfer`.** PR 112 (`c1b89e5`) closes the double-active path #101 reported. It also closes the resumed-transfer path, which this run replays on the code for the first time. Two residuals remain, and both need an owner-authorized caller that calls the transfer HTTP routes directly instead of using the CLI.

Run: `clankie heavy -- sh .agents/dev-skills/verify-body-transfer/check.sh` on 2026-11-01. It exited 0, and all 15 lines matched what was expected.

## Passed

- **Model, main as the CLI drives it** (`cli`): no two bodies are active with the same self, and Clankie is never lost (1,488 distinct states).
- **Model, guard checks:** the bug comes back without PR 112's checks (`pre-112`), and also with only the source's abort check removed (`brk-abort-unbound`). The older broken-guard configs still fail as expected.
- **#101's abort replay** on the real `BodyTransfer`: S refuses B's burn with `answer_not_from_recorded_destination`, and only A ends up active. Aborting with A's burn is still refused with `transfer_applied`, whether A has finished booting or not.
- **Resumed-transfer replay** (new). The real `runTransferCommand` runs against the real HTTP routes. `clankie transfer --transfer-id t --to B`, after A applied, is refused with "was frozen for A" before it writes anything. `clankie transfer abort --to B` is refused the same way. Only A ends up active.

## Residuals (expected findings, replayed on the code)

1. **Abort trusts the label.** The source checks the `destination` label in the abort request, but nothing in the destination's answer says which body burned the id. B's burn sent with the label A is accepted, and the same self is active at S and A.
2. **The bundle isn't tied to its destination.** The source serves its bundle to anyone, and a body stages and applies it without checking who the source froze for. Over the real routes:
   - B stages and applies it after A applied: active at A and B.
   - The model's shortest path: B stages it, the owner aborts correctly through the CLI with A's burn, then B applies: active at S and B.

The CLI never sends either request, so a normal owner using `clankie transfer` can't reach these. A script, a paired app or a future client using the routes could. Closing them at the source would mean tying the bundle or manifest to the recorded destination, and having a burn name the body that made it.

## Notes

- The `about 23k states` in the issue doesn't match this model: the original `same.cfg` also explores 1,488 distinct states (3,657 generated). The model's state space is unchanged by this run.
- The skill's sync commit is now `9a9a4a3`. The model replaces `SameDestination` with `Bound`, the set of steps held to the destination recorded at freeze.
- Not covered: crashes inside `applyStaged`, `replace: true`, `rebind`, bundle bytes and hashes, route auth, and `reclaim --force`.
