# ADR 0062: Voice join by asking

Status: accepted (2026-07-26). Builds on
[ADR 0050](0050-voice-presence-authority-tier.md) (the voice presence authority
tier) and [ADR 0057](0057-realtime-voice-with-captain-handoff.md) (the realtime
voice architecture and its consent disclosures), neither of which changes here.

## Context

`/clankie join` and `/clankie leave` exist and work, but a slash command is how
you operate a bot, not how you talk to a member. In a room where Clankie is
already a social presence, "clankie hop in vc" typed into the text channel is
the natural ask — and the owner explicitly rejected slash-only presence as
bot-like. The official bot should move in and out of voice the way a person
does: because someone asked them to, in words.

Two facts shape where that decision can live:

- Join authority already sits in the bridge (ADR 0050's presence tier, the
  deny-by-default guild allowlist, the optional channel allowlist), beside the
  gateway voice-state cache and the media-owning `DiscordVoiceSession`.
- The captain has no presence-action tool, and no control-plane→bridge command
  transport exists. The protocol's catalogued `discord.presence.voice_join`
  action is still refused by the control-plane-hosted runtime.

## Decision

The decision lives at the bridge's text ingress boundary, in the pattern this
repository already uses twice (the text reply policy of ADR 0051, the voice
volition call of ADR 0057): a cheap mechanical gate, a bounded model call that
only interprets, deterministic authority and execution, and a captain who is
informed rather than asked.

```mermaid
flowchart LR
  M["guild message<br/>admitted by text ingress"] --> G{"gate (free)<br/>addressed · author in voice<br/>loose voice-token regex"}
  G -->|closed| T["normal captain turn<br/>untouched"]
  G -->|open| D["intent decider<br/>CLANKIE_VOICE_VOLITION_MODEL<br/>join / leave / none, fail closed"]
  D -->|none| T
  D -->|join / leave| A["deterministic execution<br/>ADR 0050 tier · voice allowlists<br/>asker's channel from the gateway cache"]
  A -->|"voiceSession.join / leave"| V["DiscordVoiceSession"]
  A --> N["content-free note<br/>enums + ids only"]
  N --> T2["the SAME captain turn<br/>reply reflects reality"]
```

- **Gate (free).** Runs only on inbound guild messages that already pass the
  ingress admission text ingress applies and that address him — the same
  `mentionsBot`/`addressesCharacter` test, never a second matcher. It opens
  only when the author is currently in a voice channel of that guild per the
  gateway voice-state cache and the body matches a deliberately loose
  voice-token regex. Closed means zero added cost and an untouched turn.
- **Intent decider (one bounded call).** The brokered OpenAI key and
  `CLANKIE_VOICE_VOLITION_MODEL` — the same cost tier as the volition call, not
  a new knob — at temperature 0 with a hard timeout, asked one question: does
  this message ask Clankie to join the speaker's voice channel, to leave voice,
  or neither? Anything but a clear answer is "none" (fail closed). It reads the
  message body only — never room audio, never transcripts — and the body is
  never logged.
- **Deterministic execution.** The model authorizes nothing. A read ask runs
  exactly the slash checks — `authorizeVoicePresenceCommand` under
  `DISCORD_VOICE_JOIN_POLICY`, the `DISCORD_VOICE_GUILD_IDS` /
  `DISCORD_VOICE_CHANNEL_IDS` allowlists, and slash leave's cross-guild bound —
  then joins the asker's *current* voice channel, read from the gateway cache
  at execution time. The model returns an intent enum and nothing else, so a
  prompt-injected body can never steer *where* he joins. If he is already in
  exactly the asked channel, nothing is rejoined: a rejoin resets the consent
  registry, and silently un-consenting a room is worse than doing nothing.
- **Consent is never granted by asking.** An asked join opts in nobody — the
  asker included. Everyone consents through `/clankie voice-consent opt-in`,
  which already carries the residency disclosure ephemerally. The slash join
  keeps auto-opting-in its invoker, who sees that disclosure in the ephemeral
  reply; an asked join has no such reply, so it has no basis to opt anyone in.
- **The captain is informed, not authorizing.** The executed outcome travels
  into the same message's captain turn as `voicePresenceNote` — a strict
  enums-and-ids object (`joined` / `join_refused` / `left` / `leave_refused`
  plus a bounded reason), rendered by the control plane as one neutral factual
  line of ephemeral thread context. His conversational reply reflects what
  actually happened: he is the voice, the bridge is the actor.

## Options weighed

- **A captain presence-action tool plus a control-plane→bridge command
  transport** — rejected. It requires building two new infrastructures to move
  a decision away from the place that already holds its authority (ADR 0050),
  its data (the gateway voice-state cache), and its executor (the media-owning
  session) — and the execution plumbing would still end up in the bridge. The
  catalogued `discord.presence.voice_join` action stays as-is for a possible
  future captain-initiated surface.
- **A pure phrase matcher, no model** — rejected. Brittle rule-per-trigger:
  every new way of asking ("come hang", "you can dip") becomes a code change,
  and the repository's settled pattern is one cheap mechanism where the model
  interprets and never authorizes.
- **Do nothing (slash only)** — rejected by the owner. A member you must
  slash-command into a call is a bot, and the social presence ADR 0045 built is
  the point.

## Consequences

- Gated messages cost one cheap model call; everything else costs nothing. The
  gate is deliberately loose because a false positive is one bounded call and a
  false negative is a missed convenience.
- The intent decider is untrusted-input-facing, but it returns only an enum:
  a hostile body can at most ask him to join the channel its author is sitting
  in, under the asker's own authority.
- The join surface widens from slash to natural speech within the same
  authority tier — who may move him is unchanged; only the phrasing is.
- An asked join starts with zero consented participants, so he sits in the
  channel hearing nobody until people opt in. That is the consent model working
  as designed, and the injected note tells him so, so he can say it.
