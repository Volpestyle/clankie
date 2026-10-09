# Model config and persona image test pruning — VUH-1925

Proposed PR batch: 12 test lines and one case removed, 935 → 923 lines.
`model-provider.test.ts` loses two JSON whitespace assertions and a trivial
variant lookup case; `persona-images.test.ts` loses two rendered count sentence
assertions. Product code and exports stay unchanged. Atomic parsed config values,
credential/model/effort contracts, actual folder counts, settings persistence,
missing-folder refusal and both restart warnings remain. Both persona integration
cases remain. The unchanged configured-model consumer exercises real SDK request
schemas with local fixed fetch replies; no eval or live provider call runs.

Before gate: exit 0, source stable, 65/65 cases, 70.546633375 seconds,
HEAD `70727e33165cffea3aa9ffdea86b30f42bb5c11b`, fetched base
`63d1937231fb020f6e5b784edecf4e95bd4b3d74`. The temporary comment selectors
were removed before pruning. Separate retained consumer proof: 12/12 cases.
The baseline includes changes on main since the original branch point; the PR
will be rebased before its final gate. Wall times include different cache/load
conditions and do not establish a speedup.

After gate: exit 0, source stable, 64/64 cases, 105.626171125 seconds,
HEAD `b0b135d2430bcb043393523f3000e0a6188506dc`, base
`63d1937231fb020f6e5b784edecf4e95bd4b3d74`. Every phase passed.
Focused after check: 76/76 cases (62 model-provider, two persona integration,
12 unchanged configured-model consumer), zero failures or skips. Source/test
counts are 873 → 863 and 62 → 60 lines, 63 → 62 and two → two cases.
The root gate will be repeated on the final evidence commit before branch push.

Raw baseline, after, consumer and focused results, original files and the exact
cut are retained through the content-addressed [archive manifest](evidence.json).

Landed subtotal: six batches, 688 lines and 39 cases. This PR proposes seven
batches, 700 lines and 40 cases after merge. Fixture bulk remains separate.
Discord cut `70727e33` already landed and is not counted again; its
[archive results](../2026-10-09-discord-helper-test-pruning/README.md) and manifest
are included here as directed. The full inventory is incomplete.
