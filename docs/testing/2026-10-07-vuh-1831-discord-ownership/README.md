# VUH-1831: Discord ownership and room skills

Implementation: [ADR 0251](../../adr/0251-discord-owners-and-room-skills.md).
The service, API, CLI and TUI share server role/owners and room skill settings.
App controls in clankie-app ([VUH-1835](https://linear.app/vuhlp/issue/VUH-1835))
and hosted dashboard controls in clankie-ops
([VUH-1836](https://linear.app/vuhlp/issue/VUH-1836)) are named follow-ups, using
the same API. They are not implemented in this landing.

## Local boundary evidence

The household integration uses the actual installed house-hunting skill,
Python and SQLite, in a temporary household. It creates and reads criteria,
imports a fictional listing, records a non-owner's attributed rejection, and
verifies that the shortlist excludes it. Stale criteria updates and revoked
grants are refused. No original household files or live settings are changed.

Feedback stays attributed to authenticated speaker IDs. Old name-attributed
rejections stay readable and excluded, including after an ID-attributed decision
is reconsidered. [VUH-1834](https://linear.app/vuhlp/issue/VUH-1834) tracks an
explicit owner-confirmed ID→legacy-author binding; display names never confer it.

An actual Pi session receives only the bounded household tool. Trying to
activate bash, filesystem and fleet tools leaves only `house_hunting` in the
callable registry. No model requests or evals run. Missing owner-installed
skills skip this dependency test in ordinary CI; an explicitly provided missing
dependency fails rather than claiming coverage.

The Discord role integration crosses the stored settings, environment,
protocol schemas and final native REST adapter against a local HTTP contract
service. Native member responses prove role ownership; public rooms and
non-owner administrator roles refuse private outreach. Revocation during a
native membership read prevents mutation. This proves our boundary, not live
Discord permissions or invitation grants.

The CLI/TUI integration uses the real CLI process, TUI overlays, revision-fenced
HTTP API and SettingsStore. It covers paginated named choices, role ownership,
room grants, removal, stale revisions and invalid/retired grants.

Migration coverage loads a legacy settings file, preserves Just me policies
and the existing household binding, clears the retired machine grants, then
persists once. Removing the room grant does not recreate it. A mixed-audience
resource loader omits workspace instructions and the owner's skill catalog;
production mixed-room sessions also omit global memory, MCP and fleet context
and use fresh Pi handoffs rather than an owner-native harness.
Realtime voice briefings also require owner-audience proof before reading fleet
work or other text rooms. Mixed-room coverage verifies those private reads never
run; unavailable audience metadata leaves the voice social. Screen-share observations
and voice self-state filter the body’s global stream snapshot to the host-bound
room, including when the latest frame belongs to another room.

Reproduce the real installed-skill integration:

```sh
clankie heavy -- env HOUSE_HUNTING_TEST_SKILL_ROOT="$HOME/.agents/skills/house-hunting" \
  pnpm exec vitest run --config vitest.config.ts \
  apps/clankie/test/discord-room-skills.integration.test.ts
```

The landing gate is `clankie heavy -- pnpm check:landing`. Its final result is
recorded on VUH-1831 with the landed commit.

## Open deployment acceptance — Clankie owns these checks

- [ ] Deploy the migration; inspect effective and persisted settings without
      replacing owner-authored configuration.
- [ ] Oathkeeper (`866430493889134672`) is Admin, Just me; blinker city
      (`1052402897645752351`) is Participant, Just me.
- [ ] #house-hunting (`1551975693582336060`) grants house-hunting, uses the
      existing criteria/ledger, and permits a non-owner's household flow while
      refusing shell and fleet access.
- [ ] Live role ownership works; removing membership or a grant revokes access.
- [ ] Mixed rooms withhold private work/fleet/machine detail even at an owner's
      request; no owner-native history or global memory enters their context.
- [ ] Private outreach, asks, relays, tracking and fleet projections refuse
      audiences containing non-owners. Verify the created rooms' real Discord
      permissions, including administrator bypass and thread inheritance.
- [ ] Complete the app and hosted dashboard controls as the named follow-ups.

Audience proofs deliberately fail closed when metadata is missing or a
non-owner administrator role could bypass channel overwrites. Household API
search/detail use the existing broker-held Axesso key; live provider research
and model behavior are left to Clankie's authorized live verification.
