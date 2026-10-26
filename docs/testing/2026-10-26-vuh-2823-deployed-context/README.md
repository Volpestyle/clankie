# VUH-2823 deployed context proof

![Deployed context rows and explicit control limits](clankie://evidence/sha256/bc23b0501e8fb483d828a92b69938c43087a3fc0ccc8607d43a1bb09b0ecee79)

[Actual efficiency CLI](clankie://evidence/sha256/fd4b9a8bfd9671ea810833f90a9c56e827c187c59c4128e8efcbd31964a8e0cb) · [Actual fleet status](clankie://evidence/sha256/b88f5b2400c49fe1756422d6117d81a928a39dbdd202c042633307bca05e3135)

Runtime `6dc1d4469dba90497b80fe3991cad657c91cc2e1` was confirmed by the lead in
message 11: rollout `8b51b32f`, canary passed at `2026-10-26T16:28:42.444Z`,
31 samples, hold released. A fresh `clankie status` read confirms healthy service
and runtime health at `2026-10-26T16:38:56.939Z`.

Actual commands, read-only against the installed service:

```sh
clankie agents efficiency --conversation global-default
clankie fleet status
clankie status
```

At `2026-10-26T16:36:58Z`, the global-default efficiency output reports:

| Native seat                              | Harness | Context tokens | Context flag                          |
| ---------------------------------------- | ------- | -------------: | ------------------------------------- |
| Dex `term_65ea04595a718173` / `a383aa17` | Claude  |        432,183 | `context 432183 tokens (300K budget)` |
| Pike `term_65ebf1d44afe218f`             | Codex   |        287,223 | none                                  |
| Theo `term_65ebf2183cb00191`             | Codex   |        154,565 | none                                  |
| Mabel `term_65ebf1f2d6297190`            | Codex   |        237,168 | none                                  |
| Wynn `term_65ebfbdc7030d193`             | Codex   |        235,266 | none                                  |
| Sage `term_65e92aca921b0156`             | Codex   |        297,710 | none                                  |

Independent read-only exact-session native tails were restricted to each public
row’s `checkedAt`. All six known rows match the latest main-thread native input
at that observation. Dex’s native input is input + cache read + cache creation;
Codex’s is native `last_token_usage.input_tokens`, already including cached input.
Counts can subsequently grow; later reads are not expected to equal an earlier
snapshot. Full components, timestamps and native session IDs are retained in the
[verification capture](clankie://evidence/sha256/534e179a68ffb5830fb858854a1402418064568f065713de6e749613f39ae9d7).

`clankie fleet status` includes the same known observations and unknown Claude
rows. Its unowned local Claude rows and remote rows are not presented as known
zero-token controls. Source-side native reader reads found smaller inputs for
three local Claude sessions, but this deployed roster did not report those
counts, so they are not claimed as deployed token rows. No compact, restart,
reattachment, account action or context-inflating activity was performed.

## Acceptance limits

The deployed over-budget Claude flag and below-budget Codex controls are proven.
No currently listed Codex seat is over 300K; no known unflagged Claude token row
exists in this public capture. These requested cross-harness controls remain
unproven by this capture. Historical source/native proof (Codex 372,715 and head
436,562) is retained separately in the earlier evidence folder, not relabeled as
current deployed proof. The operator head remains deliberately excluded from
worker efficiency per lead decision; its restart path belongs to VUH-2849.
Unknown-after-compaction behavior is covered by the existing real transcript
boundary integration proof, not a forced live compact in this capture.

The image summarizes actual CLI observations and these limits. Raw CLI/status
captures and native usage components are retained through the evidence store.
Lead owns acceptance/closure; VUH-2823 is not closed by this worker report.

## Later natural Codex flagged control

A mandatory pre-commit `clankie fleet status` read at `2026-10-26T17:15:43.426Z`
now reports Pike’s unchanged native session `01a1789b-03c1-7671-8235-b016eb4fd2bb`
at **343,865** tokens with `context 343865 tokens (300K budget)`. Its exact native
`token_count` at `17:10:22.899Z` matches (input 343,865; cached input 343,296 is
already included). Dex’s Claude row is **438,150**, flagged, and Theo’s Codex row
is **238,054**, unflagged. No activity was requested to grow these contexts.

A read-only `clankie update status` reports actual running revision
`1fa743e349327245abfbcfffca5b80c32f9805be`, healthy, rollout `9c193501`, canary
passed at `17:09:16.085Z`, 31 samples and hold released. Fresh service health is
healthy. This is a later observation following the lead-owned rollout; this
worker made no deployment request. [Raw public rows, exact native components,
running revision/canary and health](clankie://evidence/sha256/5e55c16afa1426921a5915b894089c6c2b049732f8319e38f82513f36197b446).

The earlier “no flagged Codex row” limit applies to the first snapshot and is
resolved by this later natural control. A known unflagged Claude token row is
still absent from these public captures and remains an acceptance gap.
