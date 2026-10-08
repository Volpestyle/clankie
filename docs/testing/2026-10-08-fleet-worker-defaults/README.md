# VUH-1746 — worker defaults acceptance

[VUH-1746](https://linear.app/vuhlp/issue/VUH-1746) was implemented earlier;
this audit closes the remaining verification/landing criterion without adding
another settings path. Fresh worktree from fetched main
`7ae6b6e241acd83a3b91186a67ce881bc030f369`.

## Landed scope

Fen's reviewed candidate `8f001bfcb32595929b5565eb98535731f3220e11` is not a
main ancestor by SHA. Its six-file port landed as
`e5d2405a99e117d9e88f6edcb715136ebe759c4f`, which is a main ancestor. That
commit changes only the fleet CLI/TUI, persistence tests, protocol export, CLI
docs and this-machine worker-default reference. Superseded pet/app ADR work
was not part of it. VUH-1813 subsequently routes these controls through the
shared owner-authorized, revision-fenced fleet settings API.

| Acceptance                                               | Current behavior and proof                                                                                                                                                                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI/TUI edit harness, model, effort; auto clears a field | `clankie fleet set --harness NAME --model NAME --effort LEVEL`; `auto` removes the selected field. TUI `/fleet` uses the same writer, auto harness/effort and an empty model.                                                                            |
| Preserve other fields, role overrides and resources      | Retained integration writes through the actual owner settings route and reloads disk. It preserves subagent defaults, account, placement, delegation, project role precedence, autonomy and resource settings. Invalid/mixed flags refuse before saving. |
| Readable defaults and fleet clear                        | CLI `fleet status` and TUI `/fleet show` report stored defaults/effective role profiles. Tests clear each field and the whole fleet, then reload persisted settings.                                                                                     |
| Focused checks and narrow port landed                    | Actual six-file landing audited above; current-main checks recorded below. No implementation changes in this audit.                                                                                                                                      |

See [CLI](../../cli.md) and the shipped
[this-machine reference](../../../.agents/skills/this-machine/reference/herdr.md#worker-defaults).
The retained TUI regression drives the real command/setup flow using fixture
input; it does not prove a new native interactive screenshot. The CLI regression
uses a disposable settings store and actual owner route. No live fleet defaults,
accounts, resource policy, project overrides or running workers were changed.

## Verification

**26 tests passed** (14 CLI/TUI command persistence + 12 real fleet API),
TUI typecheck and documentation checks passed, without exclusions.
[Commands and results](checks.txt) retain the current-main narrow gate through
`clankie heavy --`. Dependencies were installed in the fresh owned worktree;
tracked source and lockfile remained clean before this evidence-only change.
No full suite, eval, release or live machine configuration was performed.
