# Live proof: Stop for an interactive Claude seat

Issue: [VUH-2680](https://linear.app/vuhlp/issue/VUH-2680) · 2026-10-23 03:58–04:00 UTC

[`apps/clankie/scripts/prove-claude-stop.ts`](../../../apps/clankie/scripts/prove-claude-stop.ts)
ran against the owner's real Herdr and a throwaway interactive Claude that the
prover started in its own pane (`w4F:p21`, cwd `.local/stop-proof`, worker plugin
disabled for that session) and closed afterwards. Every Herdr call in the script
is fenced to that one pane. The real Herdr runner, Claude seat control,
`HerdrWatchStore.stopNativeTask`, `SeatOutbox` and `settleStoppedTurn` ran. The
service's HTTP and authority layer did not: the scratch stack disables Herdr, and
the installed service does not have this change. The worker channel did not run
either, so the hook log's `SessionStart` was recorded by the script, and a
`herdr agent prompt` stands in for the channel when the released message is shown
reaching Claude.

## Results (`run2-final/`)

| Case | Observed |
| --- | --- |
| Stop mid-turn, 15 s into a streaming reply | `{"outcome":"stopped"}` in 563 ms; one `esc`; authority checked 3 times; the pane shows `Interrupted · What should Claude do instead?` ([after](run2-final/a-after-stop.txt)) |
| Queued message held behind the turn | admitted `queued`, still held after 1 s; released 567 ms after Stop (4 ms after it returned) with no hold expiry; Claude answered `RECEIVED` ([answered](run2-final/a-queued-answered.txt)) |
| Draft typed while Claude works | `unavailable`, "Claude's input line holds an unsent draft that Esc would clear; nothing was sent."; 0 keys; Claude still `working`, draft intact ([before](run2-final/b-draft-before.ansi), [after](run2-final/b-draft-after.txt)) |
| Roster capability | `{"deliveryModes":[],"interrupt":true,"nextTurnOnly":false}` |

The working screen with an empty input line ([`a-busy-empty.ansi`](run2-final/a-busy-empty.ansi))
is now the golden `apps/clankie/test/fixtures/pane-draft/claude-busy-empty.ansi`.

## Early Esc (`run1-early-esc/`)

The first run sent Esc 4 s into the turn, before Claude had printed anything.
Stop reported `stopped`, which is correct: Claude went idle. But instead of
printing `Interrupted`, Claude put the original prompt back into its input line
([after](run1-early-esc/a-after-stop.txt)). The stand-in prompt then appended to
that restored text. The real worker channel does not type into the input line,
so a channel delivery is unaffected; the restored text stays an ordinary draft
for the owner to send or clear.
