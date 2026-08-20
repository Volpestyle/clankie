# ADR 0071: Presence as consent, as an owner-configured voice policy

Status: accepted (James, 2026-07-26). Implemented in the voice consent
registry, the Discord settings schema, and the bridge's voice session
composition, with the policy behavior pinned by tests.

## Current status (2026-08-19)

The consent policy remains current for Clankie's Discord room. Mid-play room
input reaches only Clankie's own play through `@clankie/play-voice`; external
harnesses are outside this consent and transport path under
[ADR 0129](0129-each-player-owns-a-body.md). Possession comparisons below are
historical.

## Context

ADR 0045's consent boundary is explicit and session-bound: nobody's audio is
captured until they run `/clankie voice-consent opt-in` from inside his active
channel, and a restart, leave, or rejoin empties the registry. That is the
right default for a deployment whose participants are strangers.

In practice this deployment is one private server whose participants are known
to the owner (the same trade ADR 0053 records for unannounced possession). The
explicit ceremony had real costs there: every bridge restart silently
un-consented everyone, the most common symptom is "he talks but never replies
to me," diagnosing it required reading receipts, and the fix is command
liturgy retyped in chat after every session.

## Decision

Consent policy becomes an owner setting, `discord.voiceConsentPolicy`:

- **`explicit`** (default): exactly ADR 0045's behavior, unchanged.
- **`presence`**: being in Clankie's active voice channel is consent. The
  registry permits any speaker in the session's guild and channel — audio only
  arrives from that room's participants — and captures nobody anywhere else.

Two guardrails hold under either policy:

- **A refusal always wins.** `/clankie voice-consent opt-out` binds for the
  rest of the session, survives leaving and rejoining the channel, and is
  cleared only by that user's own later opt-in. Presence implies yes; it never
  overrides a spoken no.
- The setting is deny-by-default (`explicit`) and lives in the operator
  settings with the usual env override (`DISCORD_VOICE_CONSENT_POLICY`), so
  choosing `presence` is a deliberate, recorded owner act — not something a
  restart or a stray export can flip.

## Consequences

- On this deployment, anyone in the channel with him can talk to him — in
  conversation and mid-playthrough through the possessor seam — with no
  per-session ceremony, and chat carries no consent commands.
- The owner handles disclosure:
  participants of a `presence`-policy room should know he transcribes while he
  is in it. The trade rests on the deployment being private and its
  participants known, and it should be revisited if that stops being true —
  the same trigger ADR 0053 records.
- `explicit` deployments are untouched; the registry's default construction
  and every existing test keep their behavior.
