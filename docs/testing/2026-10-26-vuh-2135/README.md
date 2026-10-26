# VUH-2135: intact PC messages and staged-file cleanup

Base: `251de1c794876d5c2dbf02caf1a6f8d1a3081e78` (fetched and rebased before work).

## Existing work retained

`2a2e535a5`, `548ead863`, `f0299a5ad`, `bda47c48e`, `d025927d5` stream finite
SSH wrappers and preserve definite pre-launch failure versus uncertain handoff.
VUH-2258 (`2d2d558fd`, `1718f70f1`) already stages oversized Windows Codex queue
bodies. VUH-2779's exact channel ACK, turn serialization and final authority
proofs remain in place. Raw argv still fails at 32,768 characters; the existing
staged path crosses that boundary, so the old triage's implementation gap was stale.

## Live proof exposed a second limit

The lead sent `.local/vuh-2135/live-proof-20480.txt` exactly once to
`pc/term_65e6e503f6d9b1c` (Rowan). Source: 20,480 UTF-8 bytes, SHA-256
`f2d06973173a9c869a1abba6f437f8af4aa15b2ecc6d62a58fdb20a56fd9eb00`.
Original receipt: `seat-b31dfb6d-0c67-40f3-a008-2cc648beab94`, `delivered`,
`queued_until_turn_end` (channel acceptance, not read proof).

Rowan inspected native transcript `f6dae106…jsonl`, line 60156, for that event.
The body was only 16,049 bytes, missing 4,431 characters and its sentinel. The
channel appended its honest 16,384-character clipping notice. This is a failed
intactness proof, not a successful delivery of the requested body. It was never
replayed. A new proof is required after the patch is live.

## Change

PC Claude bodies above the channel bound now use the existing Windows staging
mechanism before the final occupant and authority checks. The wire event is a
short path/SHA-256 pointer; mailbox deduplication and receipts retain the full
original body's fingerprint. Native receipt matching confirms the actual pointer.
The explicit mailbox fallback uses the same projection. Other oversized seat
content keeps the existing clipping notice and schema bound; running bridges do
not need a new wire contract.

Staging uses a generated filename, exact UTF-8 bytes and a PC-computed SHA-256.
Failed/mismatched staging, authority refusal and proven pre-launch failures
attempt deletion of that exact generated file. Cleanup does not trust a failed
response's path and cannot change the send verdict. An accepted or uncertain
pointer retains its file until the receiver reads, verifies and deletes it.
Abandoned files older than seven days are pruned on a later staging write; if
cleanup itself fails, that fallback remains. No send is retried or switched to
another route on uncertainty.

## Verification

- Expanded adapter/outbox/transcript/SSH/authority checks: 100 passed, one existing
  opt-in skip. Includes 20,480 and 32,768-character pointer delivery through the
  real Claude adapter and mailbox, exact original receipt fingerprints and
  complete staged-file readback/removal. The local fixture does not establish a
  live PC seat's receipt.
- Real-PC baseline: oversized raw argv returned definite `not_sent`; existing
  staging verified the full Unicode body's hash and reached real Codex with the
  short pointer. A fresh nonexistent thread ensures no seat receives it.
- Real-PC runs retained intermittent SSH/PowerShell timeouts, including the
  unchanged 20,000-character argv/hash probe and staging. A later full-size queue
  probe passed. Six isolated real-PC cleanup cases then passed: mismatched hash,
  lost staging reply, guard refusal, definite not-sent, uncertain and accepted.
  Each case owns its own SSH master; queue acceptance/failure is injected at the
  native boundary, and real PC file bytes/existence/deletion are checked. These failures
  are retained alongside passing results, not hidden by retries.
- Service source and all 15 test-partition typechecks passed. Landing/review pending.
- Required new live ~20 KB intactness proof pending lead rollout and single send.

Raw logs/JSONL are published through the adjacent evidence manifest. Only this
README and the manifest are committed from this evidence folder.
