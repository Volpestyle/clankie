# apps/discord-bridge/test/voice-intent.test.ts

The largest bridge suite: the asked voice-presence
path end to end, fully offline. Sections mirror
the module: the mechanical gate (all three doors —
voice token, named-asker-in-voice, pending retry —
and every closed case), the intent decider
(bounded rendering with role-attributed context,
strict join/leave parsing, fail-closed transport
handling, no body echo), deterministic execution
(authority, allowlists, cross-guild bounds,
no-rejoin-resets-consent, honest failure notes),
the composed path (execution-time channel reads,
the replayed live misses: "hop in vc" and
follow-ups without his name), and the pending
retry window ("try now" retries, unrelated
chatter cannot ride it, one asker/one channel,
expiry, 64-entry bound, reopening on a raced
not_in_voice, retry vs standing prompt framing).
