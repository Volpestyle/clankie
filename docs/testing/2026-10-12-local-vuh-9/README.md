# LOCAL-VUH-9 — preserve builtin delivery on retirement

Tracks: clankie-work://local/issue/6d57411a-f547-4c5b-842c-909d2b009c61

The keeper now records retirement activity in a scoped comment when the builtin
item is already landed, delivered, or owner-verified. It preserves delivery and
current status, including the evidence bundle, independent check, and owner ask.
The saved tracker backend is supplied by the existing verified scope route.
Ordinary accepted-item transitions and Linear retirement remain unchanged.

The installed source proof is
[the original raw archive](clankie://evidence/sha256/0f65ba9429ae9c9864d4086cd18d511be214e7c879a09aa6e293e182e4c527cd).
Its hash was verified and its embedded proof matches the supplied local file.
Inspected audit 98/99 both refuse `save_issue` at the correct LOCAL-VUH-8 UUID
7bf73956-fe04-496c-9b07-9d226d7125c1, because landed → accepted requires the owner.
This repair changes retirement bookkeeping, not the already-landed attribution fix.

Focused checks use the existing `seat-issue-scope.integration.test.ts` and
`seat-issue-status.integration.test.ts`: 2 files, 8 tests passed. The extended
contract uses real disposable tracker/evidence stores, production keeper,
WorkItemsService scope routes and hire ledger. Raw audit deltas show only
successful `save_comment` writes for preserved retirement, with no delivery event
or verification write. Existing scope, native attribution, collision, refusal,
accepted-item and disposable Linear API contracts also pass. Explicit-file format
and lint checks pass. The package typecheck passes (source plus 13 test compiler
partitions). Commands run through `clankie heavy`.

Independent native review approved the corrected product diff with no blocking
findings; its SHA-256 is
`06701b247e14b0db5e148b1a5f45e11317d523ae38ef00a101d7bdc69b783529`.

Limits: native PID/session/socket observations are synthetic fixture inputs.
Owner-verified is seeded as explicitly synthetic pre-existing persisted state in
one disposable store; no owner call or verification answer is used. Fixture owner
asks are empty: preservation of an existing nonempty ask follows from the
comment-only route and is not directly exercised. The Linear
provider is a disposable real HTTP/schema fixture, not a live account. These
checks do not prove installed retirement after this change, live account/scope
churn, owner verification, deployment health, or shared landing. Global retains
the exact-tree root gate, landing and deployment. No new retirement actors,
harness panes, evaluations, config changes or restart were used.

The retained evidence manifest contains the raw route proof, checked diff,
focused output, independent native review, source archive inspection and current
item/related bundle readbacks. Publication metadata records the base checkout;
the checked diff and review hash identify the changed inputs. This is worker
proof, not an integration or deployment receipt.
