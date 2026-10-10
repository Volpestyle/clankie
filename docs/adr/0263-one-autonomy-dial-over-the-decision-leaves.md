# ADR 0263: One autonomy dial over the decision leaves

Status: accepted by the lead for VUH-2020, 2026-10-10.
Tracked by [VUH-2020](https://linear.app/vuhlp/issue/VUH-2020); designed with
[VUH-2029](https://linear.app/vuhlp/issue/VUH-2029) (projects on Auto).
Builds on [ADR 0230](0230-fleet-responsibility-is-owner-settings.md) and
[ADR 0246](0246-worker-questions-use-native-hook-answers.md).

## Context

How much Clankie decides on his own was spread across nine owner leaves: four
worker gates, closure, machine setup, commit, push and release. Owners could
tune each one, but there was no single "how much do you decide" control. The
default gates were Balanced, which sends every hard-to-undo change to the owner.
The owner direction on 2026-10-10 was for high autonomy by default: Clankie
should take as many decisions as he can.

Owners need two separate controls. One says **whether he works unprompted**:
today that's the goal/self-wake switch in `~/.clankie/captain/autonomy.json`, and
VUH-2029's per-project Auto with a master On/Off will replace it. The other says
**how much he asks** while he works. Tying them together would make a dial move
from high to full quietly resume work the owner had paused.

## Decision

One dial, `off`, `low`, `high` or `full`, sets the decision leaves. `high` is
the default.

| Leaf               | Off   | Low   | High (default) | Full  |
| ------------------ | ----- | ----- | -------------- | ----- |
| Everyday work      | owner | lead  | allow          | allow |
| Leaves your Mac    | owner | owner | lead           | allow |
| Hard to undo       | owner | owner | lead           | lead  |
| Money and accounts | owner | owner | owner          | owner |
| Closure            | owner | owner | lead           | lead  |
| Machine setup      | owner | owner | lead           | lead  |
| Commit             | owner | lead  | lead           | lead  |
| Push               | owner | owner | lead           | lead  |
| Release            | owner | owner | owner          | lead  |

Low uses the Careful gate preset and High uses Hands-off. Verification and
reporting style say how work is done, not who decides, so no level changes them.
Money and accounts stay with the owner at every level.

- **The level is not stored.** Choosing a level writes its leaves in one
  revision-fenced owner write (ADR 0248). Reads compute the level from the
  stored leaves, and any hand-set leaf reads `custom`. This is how gate presets
  are matched already. It adds no disk field, so older readers are unaffected.
- **One API.** `POST /v1/operator/fleet-settings` accepts `changes.autonomyLevel`.
  The level's leaves are written first, and any explicit leaves in the same
  change override them. Snapshots carry `autonomyLevel`. When it is missing,
  the service is older and clients must not offer the dial. The relay, the
  hosted bridge and the app already reach this route.
- **Every surface.** The CLI is `clankie autonomy [status|off|low|high|full]`.
  In the console and the hosted console, `/autonomy LEVEL` sets the dial and
  `/autonomy` with no argument opens a menu. The app shows the dial above its
  advanced working-preference chips.
- **The work switch stays separate.** The dial never starts or stops goal runs
  or self-wakes. The old `/autonomy on|off` becomes `/autonomy pause|resume`,
  which frees `off` for the dial's lowest level. VUH-2029's master On/Off
  replaces this switch when it lands.
- **Per-area overrides stay.** The individual fleet flags and project
  overrides keep working. The dial is global; a project override still wins for
  that project.
- **Default.** `FLEET_AUTONOMY_DEFAULTS` is now High. The only leaf that moves
  is `hardToUndo`, from owner to lead. A settings file that already stores
  Balanced's `hardToUndo: owner` keeps it and reads `custom` until the owner
  chooses a level. No stored setting is silently raised.

## Consequences

- Typing `/autonomy off` from habit now hands every decision back to the owner
  instead of pausing work. That is the safe direction, and the pause is still
  one word away.
- An autonomous turn still proposes a hire rather than making one (ADR 0187),
  at every level. The dial raises who answers questions, not what an internal
  turn may launch.
- Later VUH-2020 slices read this level rather than adding switches of their
  own: proactive ideas, posts and announcements, an owner intent record, and
  process improvement.
