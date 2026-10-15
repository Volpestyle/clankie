# VUH-2256: working preferences enforce their behavior

Tracks: https://linear.app/vuhlp/issue/VUH-2256/working-preference-knobs-do-what-they-say-enforce-or-remove-and-add

The public implementation has focused verification. Landing and deployed KH2
proof are pending. This record does not claim a green
landing gate or a deployed capability yet.

## Scope

- Project Started-issue WIP cap, milestone/silent/landing report cadence, lead and
  worker profiles, and plan/model constraints share one revision-fenced API.
- A singleton allowed-model list is a hard pin, independently of default profiles.
  Explicit request overrides cannot bypass allowed/excluded model constraints.
- Fresh subscription work hires use observed plan capacity, keep a 10% reserve
  and retain plan, remaining usage, effort and selection reasons. Explicit owner
  app choices need no typed rationale; only the usage reserve can be overridden,
  explicitly, with holds/exclusions/unknown usage and authority still binding.
- Decision asks show defaults/deadlines, expire with service attribution, notify
  the owner and queue the source lead once. They never fabricate owner answers.
- Retired controls and exact-value migration are listed in the
  [release notes](../../release-notes-unreleased.md). Saved values stay read-only.

## Focused evidence

[Raw boundary logs and retained gate attempts](clankie://evidence/sha256/71028eaeb4bd5c919564e7e5e9cc2d90f7d1d9fe2ec0002f4347cc1b7d1d8ef0).

| Check                                                                                 | Observed result                                                                                                       |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Combined settings, profiles and CLI boundaries                                        | 141 passed, one existing optional native test skipped                                                                 |
| Existing hire consumers                                                               | 63 passed, one existing optional native test skipped                                                                  |
| Real TUI modal/settings persistence and native hire boundary                          | 22 passed                                                                                                             |
| Owner app authority, explicit reserve override and native launch                      | 36 passed                                                                                                             |
| Retired-setting HTTP refusal and exact-value retention                                | 2 passed                                                                                                              |
| Hard model pin, legacy-journal recovery, project settings and hire policy             | 54 passed                                                                                                             |
| Canonical model exclusion and project creation                                        | 41 passed                                                                                                             |
| Decision deadlines, restart/duplicate/atomic-write recovery and owner gate exemptions | 33 passed; [AC6 evidence](clankie://evidence/sha256/2e4682e7ab92ab3cab19a6a160e3eaeebf1dbc8515501b4632c9c2f144b5f240) |

These runs overlap; the counts are not an aggregate test total. The private app
worker owns its app verification and native phone/tablet evidence.

## Landing checks

Attempt 1 failed on two unused exports in new code. A focused compiler also
found an optional-field mismatch and non-erasable constructor syntax; those were
fixed and the focused compiler passed.

Attempt 2 passed formatting, lint, dead-code, docs and evidence checks, then 23
of 24 selected package compilers. It was stopped (exit 130) to fix an identified
legacy hire-journal fingerprint compatibility issue; the service compiler was
interrupted. Its gate result is incomplete, not green. No test suite ran in
that attempt.

Attempt 3 failed on test compiler errors in HTTP and onboarding fixtures. Those
were corrected; 40 focused settings/onboarding tests passed.

Attempts 4 and 5 passed all 24 selected package typechecks, then stopped on
native consumer failures. The hire fixtures now supply per-job effort, reasons
and observed plan inputs. Inspection also found and fixed two behavior bugs:
service-added standing context incorrectly classified an empty manual launch as
a task, and a fresh settings save could later archive generated defaults as
owner choices. Fresh settings now retain an explicit empty migration receipt.

A no-bail diagnostic of the gate-selected tests was stopped after identifying
affected consumer failures, while repository integration machinery was still
running. It is incomplete, not a green test run or landing gate. Retired-control
write and prompt expectations were updated for the approved removal.

Focused follow-up results: 88 tests across seven hire suites; 30 relay/settings/
creation tests; 21 real native lifecycle tests, including empty manual launches
and remote authority fences. The corrected settings/Auto/model command cases
and focused compiler also passed. Counts overlap earlier runs. Root landing
revalidation and deployed proof remain pending.

The compatibility issue was reproduced by running main's actual prior writer:
the new reader refused its unchanged advanced-profile journal. The fix keeps the
legacy fingerprint when no project hiring policy is configured. A captured
journal exercises recovery and still refuses a genuinely changed model policy.

[Repair checks, nonzero gate results and incomplete diagnostic](clankie://evidence/sha256/ff5b8157bb70967788a804e5116d18a0768e23b8ba5b40d59bd481e92694df08).

## Open proof

- Green root landing gate and pushed public SHA.
- Landed app slice and its owner-choice/usage-refusal path.
- Deployed KH2 WIP 6/milestone-only set and independent readback.
- Live 10-10 through 10-13 replay with `over_wip` and the next natural Auto round.
- Live hire selection/default-deadline followthrough evidence or an explicit
  statement of the remaining runtime gap.
