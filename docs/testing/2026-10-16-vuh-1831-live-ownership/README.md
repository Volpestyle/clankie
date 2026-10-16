# Discord ownership, live on James's servers (VUH-1831)

Tracks: [VUH-1831](https://linear.app/vuhlp/issue/VUH-1831), the live half of
[the 2026-10-07 boundary evidence](../2026-10-07-vuh-1831-discord-ownership/README.md).
The model ([ADR 0251](../../adr/0251-discord-owners-and-room-skills.md)) landed
in `c8169521` and was deployed at `cd7e50cf` on 2026-10-08. This run reads the
live service's settings and trails. Nothing was edited, restarted or posted, and no outreach was fired.

## Settings, read back on 2026-10-16

`clankie discord status` (effective settings, no environment overrides):

| Server                             | Role        | Owners |
| ---------------------------------- | ----------- | ------ |
| oathkeeper `866430493889134672`    | admin       | me     |
| blinker city `1052402897645752351` | participant | me     |

- **`roomSkills`:** #house-hunting `1551975693582336060` grants `house-hunting`
  (household: existing).
- **The retired lists are empty:** `systemActorGuildIds` and
  `systemActorChannelIds`, so no room hands its members the machine.

The setting is reachable from every surface:

- **CLI:** `clankie discord owners --server ID --owners me|everyone|role`, and
  `room-skill`.
- **TUI:** the discord commands.
- **App:** `DiscordSettings` ([VUH-1835](https://linear.app/vuhlp/issue/VUH-1835)).
- **Hosted dashboard:** [VUH-1836](https://linear.app/vuhlp/issue/VUH-1836),
  in clankie-ops.

## A real non-owner in #house-hunting

**Since the migration:** a household member who is not an owner (actor
`…6782`) sent 8 messages in #house-hunting, 2026-10-09 to 10-11. Clankie
answered each in 7 turns. The 8th message was absorbed into a running turn.

- **How they ran:** every turn was a bounded room handoff and completed.
- **Tools used:**
  - the room's `house_hunting` skill tool, 22 calls in the first turn alone;
  - browser reading;
  - reply updates.
- **Tools not used:** no shell, fleet, terminal, file-writing or tracker tool
  ran in any of them.
- **Changes:** `mutatingCount` was 0 throughout.

The per-turn record is
[`house-hunting-turns.json`](house-hunting-turns.json). It was built by
joining:

- the service's settled-turn journal (`captain/turn-settled.jsonl`), and
- the text-ingress deliveries, which carry the actor ID, by run ID.

Actor IDs are shortened and no message text is included.

**The rest of blinker city:**

- **Volume:** 84 turns since the migration, the owner's included, across
  #house-hunting and #general.
- **How they ran:** all were room handoffs.
- **Tools:** social, browser, reaction or house-hunting tools only.
- **No system-authority session ran there.** Before the migration, the
  trusted-channel grant would have given every one of these turns the
  machine.

**What this shows, and what it doesn't:**

- **Shown live:** the house-hunting flow works for a non-owner under the
  room grant, and no machine or fleet tool ran.
- **Shown only by the deployed gate and its integration test:** that a shell
  or fleet tool would have been _refused_. The non-owner never asked for one.
  `apps/clankie/test/discord-room-skills.integration.test.ts` exercises that
  refusal. The live sessions' tool lists weren't retained.

## Outreach into a room with non-owners

The refusal wasn't fired live. A failed gate would publish into a server with
real non-owners, and that can't be undone.

**Where the deployed refusal sits:**

- **The code:** `captain-discord-turns.ts`. Outreach refuses with
  `discord_owner_audience_required` unless Discord membership and permission
  reads prove every reader is an owner.
- **The same gate in tracking and fleet:** `channel-projection.ts`
  (`ownerAudience`).
- **It is live:** the deployed runtime, `45522f52`, contains `c8169521`, and
  these files are unchanged between it and `main`.
- **Live config:** blinker city's owners are "me" only, and the server has
  other members, so no room there can prove an owner-only audience.

**No live non-sending path exists:** no CLI or API exposes the audience
check, as a preflight or a dry run, so it couldn't be asked of the live
service without a send.

**The proof is the integration tests, run on `main` `02deec58`:** `discord-server-role`,
`discord-room-skills` and `native-room-handoff` (17 tests, all pass;
[`integration-run.txt`](integration-run.txt)). Among them:

- "host membership proves role ownership and outreach refuses every unproven
  reader":
  - outreach is refused, with no POST made, until the audience is proven
    private;
  - it is refused again once a non-owner administrator role could bypass the
    channel's overwrites.
- "a mixed audience resource loader supplies no workspace instructions or
  owner skill catalog".
- The room-skill cases: a non-owner runs the house-hunting flow, and shell
  and fleet are refused.

## Still to check live

- **Mixed-room privacy:** one real owner message in blinker city #general
  asking for work, fleet or machine detail, traced to show it was withheld.
  It is the owner's step, and the lead is asking James for it.
- **Created rooms' permissions:** Fleet in Discord is off, so there are no
  created fleet rooms to inspect for administrator bypass or thread
  inheritance.

## Found during the read-back

`clankie discord setup check` reports the **Administrator** check as failed
for oathkeeper, although its role is Admin. Ownership and privacy don't
depend on it. It is recorded on James's open
[VUH-1622](https://linear.app/vuhlp/issue/VUH-1622).
