# docs/adr/0062-voice-join-by-asking.md

"clankie hop in vc" typed in a channel moves him
into voice — no slash command. The pattern: a free
mechanical gate at the bridge's text ingress, one
bounded intent-decider model call (join / leave /
none, fail closed, enum only), then deterministic
execution under ADR 0050's tier and the voice
allowlists.

Read for the live-run-earned details: the gate
reuses text-ingress addressing plus a loose
voice-token regex or asker-in-voice signal; a
`not_in_voice` refusal opens a two-minute pending
retry window bound to that asker/channel; the
model can never choose the channel (read fresh
from the gateway cache); asking grants no consent
to anyone; the captain is informed of the outcome
in the same turn, never asked.
