# Explicit Discord wake triggers (VUH-1765)

The wake setting, sealed context contract and hosted buffer implementation
already existed. This change corrects one public admission gap: after a reply,
an explicit `mention`, legacy `addressed`, or `name` setting still inherited the
persona's live-conversation window and admitted an ordinary follow-up. The
regression cases reproduced all three unwanted admissions before the fix.

The shared text ingress now retains the explicit setting from
`discordTextAttention` and enforces it in the common live/history admission
path. Both bring-your-own bot and user-session bridges already use that helper.
With the setting unset, the existing persona reply policy, live window and
catch-up remain intact. `any` still admits every otherwise allowed message.
Direct replies/mentions and admitted DMs still reach Clankie. Channel, bot and
DM admission checks run first. This setting controls attention; server owners,
audience privacy and bounded room skills still follow
[ADR 0251](../../adr/0251-discord-owners-and-room-skills.md).

## Evidence

- [Text inbox integration](../../../apps/discord-bridge/test/text-inbox.test.ts)
  covers explicit triggers after a real reply and SQLite inbox restart, history
  scanning with persisted attention, no ambient catch-up calls, and continued
  mention/reply/DM admission. Existing cases preserve fresh self-hosted defaults
  and the unset persona's restarted follow-up/catch-up behavior. The database,
  scanner, ingress and schema boundaries are production code; Discord history
  and captain/reply ports are fixture providers, not a live gateway or model.
- [Sealed hosted handoff](../../../apps/clankie/test/hosted-room-handoff.integration.test.ts)
  sends recent context through real encryption, authenticated HTTP admission,
  durable delivery and captain request projection, preserving author/time and
  the triggering event's verified-owner proof. Buffered context stays context,
  rather than becoming another submitted turn.
- Existing server-role and room-skill integration checks cover ADR 0251 authority
  independently of the wake setting. Settings API/TUI coverage keeps the trigger
  configurable through the existing revision-fenced contract.

All commands run through `clankie heavy --`: dependency installation, focused
Vitest checks and `pnpm check:landing`. Local logs are retained in
`.local/evidence/vuh-1765/`. No model eval, live Discord send, service restart or
live settings change was performed.

## Remaining hosted acceptance

The encrypted edge buffer, current administrator proof for channel opt-in,
tenant wake/usage ledger, deployment, threat model and privacy draft belong in
`clankie-ops`. The issue records the landed ops work separately; this public
change does not prove its current private integration or live deployment.
Message Content enablement and the official application's verification/intent
application remain owner steps. A real hosted sleep → ambient buffering →
triggered wake with recent context and the corresponding ledger evidence are
still required before claiming complete hosted acceptance.
