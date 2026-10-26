# VUH-2823: native context token telemetry

Source reader/store proof on 2026-10-26, candidate based on `251de1c79`.
This is measured against live local Herdr sessions and their native transcript
files, without changing or resuming any session. It is not deployed-service proof.

| Native seat | Session | Harness | Context tokens | 300K flag |
| --- | --- | --- | ---: | --- |
| Operator head (separate proof): `term_65d97f756b3881` | `c302c14b-2de0-48f5-b757-6535b8e75da9` | claude | 436,562 | yes |
| Claude worker (Dex): `term_65ea04595a718173` | `a383aa17-4977-4763-a3e6-6093b6a43127` | claude | 153,723 | no |
| Codex reviewer: `term_65e92aca921b0156` | `01a16d3a-98c4-75a1-9283-9cfbe61469ea` | codex | 372,715 | yes |
| Codex worker (this seat): `term_65ebf2183cb00191` | `01a1789c-1918-7412-949e-86a42e0aec98` | codex | 140,255 | no |

The source `readFleet` census supplies native terminal/session identity; titles
are not used to infer roles. The operator head (`c302c14b`) is deliberately
excluded from the worker efficiency endpoint. Its context belongs to the lead
restart path (VUH-2821/VUH-2849); the lead accepted this separate reader/store
proof plus the deployed Codex worker flag for over-budget acceptance.

Method: `prepareSeatTelemetry` resolves the exact native ID asynchronously;
`readSeatTelemetry` reads its bounded transcript tail; `SeatEfficiencyStore.observe`
passes the token snapshot through the public protocol schema and produces the
300K flag. Claude counts input + cache read + cache write, with no guessed window.
Codex counts the last call's input, retaining its native percent. Neither path
uses cumulative session spend. Compaction clears the snapshot until the next call.
No automated action is triggered by these flags.

Focused verification: 39 tests passed across the existing native reader/store
and fleet CLI integration files, including the 299,999 → 300,000 boundary,
sidechain/session isolation, compaction invalidation and restored persistence.
Required landing gate and independent review are recorded on the issue.

Final acceptance follows deployment: run `clankie agents efficiency --conversation
global-default` against the live service, attach flagged/unflagged Claude/Codex
rows and keep unknown/missing telemetry explicit. Until then the issue remains open.
