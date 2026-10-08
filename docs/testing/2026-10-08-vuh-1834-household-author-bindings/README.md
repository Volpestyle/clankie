# Owner-confirmed household authors

VUH-1834 implements [ADR 0252](../../adr/0252-household-legacy-authors-need-owner-confirmed-id-bindings.md).
The companion skill landed in `Volpestyle/skills` as
`2662c9f31408fe58e87864ee3a96fb68e2db8cdf`.

All verification used temporary settings, fictional author labels, authenticated
fixture IDs and disposable SQLite ledgers. No live settings, household ledger,
credentials or Discord account were read or changed.

## Product evidence

The focused Clankie run passed 14 tests in two files:
`apps/clankie/test/discord-room-skills.integration.test.ts` and
`apps/tui/test/discord-setup-integration.test.ts`. These cross the real settings
store, authenticated HTTP API, CLI subprocess, interactive TUI and Python/SQLite
skill boundaries. The skill's original checks and its new real CLI checks passed
through `python3 agent/house-hunting/test_homes.py`.

| Action                                                                                      | Observed result                                                                   |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Reconsider by an ID with no binding                                                         | Legacy rejection remains readable and excludes the home                           |
| Add a confirmed household binding                                                           | Existing feedback and rejection state remain unchanged                            |
| Reconsider by another ID or in another household                                            | Binding grants no legacy target                                                   |
| Reconsider by the confirmed ID                                                              | New ID-attributed row records its explicit target; original authors remain intact |
| Another author still rejects                                                                | Home remains excluded                                                             |
| Later legacy rejection                                                                      | Home is excluded again                                                            |
| Remove binding from a warm adapter                                                          | Future reconsideration cannot target that legacy label; prior history remains     |
| Bind a differently cased label                                                              | Exact original rejection remains                                                  |
| Supply model-controlled author/target                                                       | Strict room tool refuses it                                                       |
| Omit owner confirmation, use numeric legacy labels, duplicate labels or a path as household | API refuses the write                                                             |
| Old client omits the new field                                                              | Existing bindings remain intact                                                   |
| Stale revision or unauthenticated writer                                                    | Existing revision and authentication boundaries refuse the write                  |
| TUI adds multiple bindings                                                                  | Each gets a separate confirmation; cancellation saves none                        |
| Abort target insertion in SQLite                                                            | New feedback row rolls back with its targets                                      |
| Use the skill without targets                                                               | Original CLI behavior and ledger layout remain compatible                         |

The first complete `clankie heavy -- pnpm check:landing` passed 29 package
typechecks, 651 test files and 6,164 tests (the existing configured skips were
unchanged). The final post-rebase gate is recorded in the issue evidence.
Both runs explicitly select the landed companion skill through
`HOUSE_HUNTING_TEST_SKILL_ROOT`; no exclusions were added.

## Rollout and live acceptance

The deploy must include the public Clankie change and refresh the canonical
house-hunting skill to the companion SHA. An older skill refuses the new target
flag rather than silently weakening rejection filtering. App and dashboard
Advanced editors consume the same revision-fenced settings API.

Clankie owns deployment and the live house check. The owner must separately
confirm each real household, exact legacy author label and Discord ID before a
binding is saved. The live continuity acceptance on VUH-1834 remains open.
