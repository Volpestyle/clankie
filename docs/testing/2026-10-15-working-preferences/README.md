# VUH-2256: working preferences enforce their behavior

Tracks: https://linear.app/vuhlp/issue/VUH-2256/working-preference-knobs-do-what-they-say-enforce-or-remove-and-add

The public implementation landed at [d169a17e9](https://github.com/Volpestyle/clankie/commit/d169a17e9604849a5f4dee245dd76c55fb5ea9a6)
with a green root landing gate. The private app landed at
[d48665c9](https://github.com/Volpestyle/clankie-app/commit/d48665c9441ec7dd32db3a5a4f3644037f8be864).
Deployed KH2 settings, historical replay and the next natural round passed their
policy checks. The round records non-delivery; no delivered report is claimed.

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
and focused compiler also passed. Counts overlap earlier runs. The green root
landing result and subsequent deployed proof are recorded below.

The compatibility issue was reproduced by running main's actual prior writer:
the new reader refused its unchanged advanced-profile journal. The fix keeps the
legacy fingerprint when no project hiring policy is configured. A captured
journal exercises recovery and still refuses a genuinely changed model policy.

[Repair checks, nonzero gate results and incomplete diagnostic](clankie://evidence/sha256/ff5b8157bb70967788a804e5116d18a0768e23b8ba5b40d59bd481e92694df08).

## Green landing result

Root attempt 8 checked `d169a17e9604849a5f4dee245dd76c55fb5ea9a6` against fetched `origin/main`
`1110679213b4540f47f6ae50989fcea700004b0e` and passed every phase: skills, format, lint, dead-code,
docs, retired claims, evidence, all 24 selected package typechecks and tests.
The selected test result was **728 suites / 6,547 tests passed**, with **31 suites /
83 tests skipped**; exit 0, `sourceStable: true`, 934.16 seconds. A final pull was
unchanged and the checked HEAD was pushed directly to main. No load exception
was used.

Attempt 6 had passed 305 suites before an existing native-continuation spy
expected the old seven-argument internal call. Its task-intent assertion was
updated and all three callers passed (15 tests). Attempt 7 was stopped at the
lead's request (exit 130, incomplete) to finish a no-bail diagnostic first. That
complete diagnostic passed the same 728 suites / 6,547 tests with the same skips
on the unchanged tree; it did not substitute for attempt 8.

The read-only instruction audit found no fixed model/effort pin or harness split
in the active personal instructions. No dotfiles edit was made in this slice.

[Final landing log, complete diagnostic, prior nonzero/incomplete records and
instruction audit](clankie://evidence/sha256/d3b063f0683c1faab1a36a01a0525db3ed0242ba685d3bd7871bf16659da82df).

## App landing and native proof

The app root landing gate passed against the landed public `d169a17e9` in
72.56 seconds, followed by a valid base revalidation before push. Its real owner
HTTP policy test passed against that public sibling. The earlier full app check
passed against the preceding complete public draft `434a64906`.

[App gate report](clankie://evidence/sha256/0acc3730ee529da5997685ee5a0e504d26966e3f09b8be2197705ca4771608a6),
[gate log](clankie://evidence/sha256/f3fd27142488ffe95aa45ee1a4b3b261c91b135ff9861804db6dc8f4e032f9a0),
and [full app check](clankie://evidence/sha256/92e2fb8028d8da2cfead40bb663e2ff00726b6081792ae3a86a42005a387df36).

[Inspected iPhone/iPad settings, refusal and explicit retry journeys](https://github.com/Volpestyle/clankie-app/blob/d48665c9441ec7dd32db3a5a4f3644037f8be864/docs/testing/2026-10-15-project-work-policy/README.md)
use source-only samples; they did not start a real hire or mutate an account.
Physical installation remains unverified because the owner's iPhone reported
`tunnelState: unavailable`. The app worker released its simulator and Metro
resources. No load exception or eval was used.

## Deployed KH2 settings and replay

The lead reported deployed `4034fb7c1` healthy at **2026-10-16 00:42:55Z**.
The source launcher wrote KH2's `wipCap: 6` and `ownerLoop: milestones` through
the revision-fenced API, completing at 00:44:07Z. An independent project-list
read completed at 00:44:30Z and returned the same values and revision
`efbb1f32f018e16c3c6afba81cfb43290354011d864e296cc626af0b25f7a71e`.
Auto stayed enabled and the seven product-path declarations stayed unchanged.

The deployed read-only historical replay completed at 00:44:34Z:

| Completed Chicago day | Product / tooling / docs lines | Closed | Started / cap | Emitted signals                              |
| --------------------- | -----------------------------: | -----: | ------------: | -------------------------------------------- |
| 2026-10-10            |             1644 / 21138 / 861 |      0 |        22 / 6 | `tooling_lead`, `nothing_closed`, `over_wip` |
| 2026-10-11            |               108 / 7227 / 371 |      0 |        22 / 6 | `tooling_lead`, `nothing_closed`, `over_wip` |
| 2026-10-12            |                 67 / 734 / 236 |      2 |        24 / 6 | `tooling_lead`, `over_wip`                   |
| 2026-10-13            |               777 / 1592 / 378 |      7 |        23 / 6 | `tooling_lead`, `over_wip`                   |

These results match the VUH-2255 table and resolve VUH-2287's cap-null gap.
The October 13 closures split into five owner-facing and two unlinked.
Replay applies the **current configured cap** to historical started counts;
it does not reconstruct old settings. Its `over_wip.day` is the next midnight's
measurement date, while the replay ID names the completed day above. Tracker
membership remains current. Replay writes no round record or tracker state and
does not wake a lead or consume pending drift.

The initial launcher attempt entered the interactive TUI and refused without a
TTY before any write; the corrected `bin/clankie.ts` launcher succeeded. No
service restart, forced Auto wake, paid hire or eval was performed.

## Next natural KH2 round

No wake was forced. The next normal record after the policy write is
`b63a2d2c-fc15-4392-915d-b190329b3f48`, recorded at
**2026-10-16 01:12:02.472Z**, measured at **01:11:55.576Z** in conversation
`conv-7687818a-09c3-4f37-bf7b-9d201c2e1932`.

The preceding record at 00:41:57.595Z had one started issue and `cap: null`,
with no owner-loop field. The fresh record has **one started issue, cap 6,
`ownerLoop: milestones` and `report.cadence: milestones`**. It retains the
pending Shared world milestone request with no landing report. No `over_wip`
is expected at 1/6; the historical replay above supplies the positive cases.
The measured window has 16 owner-facing, 5 tooling and 3 unlinked closures,
3823 product / 6244 tooling / 624 docs lines, and 38 commits.

Delivery is explicitly **false**, settled at **01:12:09.221Z**, reason
`not delivered`; `report.updates` is empty. This proves live policy consumption,
measurement and report selection, not a delivered wake, owner report, or lead
correction. The prior round had the same non-delivery result.

[Live settings projection, full deployed replay, before/after natural round,
commands and policy checks](clankie://evidence/sha256/63910b756260873a3c1fbbbb14989dc64c00501d40ed3229c544fed37c098f62).

## Verification limits

Hire admission and deadline expiry are verified at real native, HTTP, storage
and runner boundaries in the linked focused and full-gate checks. This proof
did not manufacture a paid hire or an owner ask to expire. A deployed hire's
selection and a live lead's actual default-action followthrough remain
unobserved here. Physical iPhone installation also remains unverified as
described above. No delivered KH2 milestone report is claimed.
