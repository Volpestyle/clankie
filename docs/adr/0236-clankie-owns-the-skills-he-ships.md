# ADR 0236: Clankie owns the skills he ships

Status: Accepted (2026-10-06).

## Decision

Every skill Clankie ships is authored in `.agents/skills` in this repository and
is always on. The vendored snapshot of Volpestyle/skills, its manifest and the
"opinionated" skill class are removed, along with `skills.opinionated`,
`skills.exclude`, the exclude/include commands and `hire_agent`'s
`skills: "bundled" | "plain"` choice. Older settings files that still carry
those keys load and ignore them.

A shipped skill teaches what makes Clankie himself: how he uses his own body
and tools, how the harness driving his seat knows what he can do, and how his
hired workers work inside his fleet. That keeps his standing instructions small
and moves capability guidance into skills loaded when needed. General-purpose
skills (errands, commit and push habits, review methods) are not his to ship:
users write their own as they use him, and Claude Code and Codex already bring
good ones. A skill also has to be loaded in practice. The bundle was measured over
1,232 service, operator-seat and worker sessions over 21 days (2026-09-16 to 2026-10-06), and each
skill was kept, folded into another, or dropped:

| Skill                                                          | Loads (Clankie / workers) | Decision                                                       |
| -------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------- |
| this-machine                                                   | 44 / 86                   | Keep; core cut from 6,241 to 1,348 words, detail in references |
| herdr                                                          | 20 / 124                  | Keep (generated from the pinned binary)                        |
| lead                                                           | 21 / 58                   | Keep; rewritten, see below                                     |
| linear-orient, linear-issues                                   | 11 / 57, 6 / 124          | Keep                                                           |
| trace-clankie                                                  | 10 / 51                   | Keep                                                           |
| minecraft                                                      | 24 / 10                   | Keep                                                           |
| shared-checkout                                                | 2 / 148                   | Keep                                                           |
| work-items, clankie                                            | 4 / 65, 2 / 60            | Keep                                                           |
| tidy, fleet-resources                                          | new this month            | Keep for a fair trial                                          |
| pokeagents                                                     | 0 / 1                     | Keep: no play session ran in the window                        |
| desktop-control                                                | 10 total                  | Keep; absorbs `computer-use-delegation` (3)                    |
| browser-use                                                    | 4 total                   | Fold into this-machine's browser reference                     |
| c, p                                                           | 1 / 51, 0 / 34            | Drop; commit and push stay native to each harness              |
| reflect, solution-space                                        | 2 / 52, 1 / 38            | Drop; nearly every load came from an owner-global copy         |
| research-team                                                  | 0-1                       | Keep: Clankie's own way of running a research fleet            |
| trip-planning, comparison-shopping, daily-digest, inbox-triage | 0-1 each                  | Drop: general-purpose errands                                  |
| trip-planning                                                  | 0-1                       | Drop                                                           |

`lead` is rewritten as Clankie's leadership judgment (what to start, who does
it, briefs, harvest and delivery, efficiency rounds and authority) in about
1,200 words, down from 4,300. Fleet tool mechanics, review and landing, and
tracker records live in its three references, which `this-machine` links to
instead of repeating.

Shipped skills carry no personal names, machine names, accounts or private
issue links: they reach every install.

## Why

The opinionated class existed so an owner could switch off process guidance
copied from a personal skills repository. In practice it meant a second
authoring source that drifted from Clankie's tools (the `herdr-lead` and Swarm
references outlived both), a pinned export to refresh, a settings class with its
own picker and hire override, and skills that cost catalog context every turn
while rarely loading. Leadership is Clankie's own product behaviour, so it
belongs beside the tools it describes and changes in the same commit.

## Consequences

- Owner-global skills in `~/.agents/skills` are untouched. Plain harnesses
  outside Clankie keep whatever the owner selects there, and Clankie still finds
  them through `skill_search`.
- Volpestyle/skills may keep generic versions for other harnesses; Clankie no
  longer reads or pins it.
- The A/B evaluation arm that toggled the opinionated class is gone. A future
  skill experiment uses an explicit eval fixture, not a product setting.
- Supersedes the vendoring and two-class sections of
  [bundled skills](../bundled-skills.md) as of this date.
