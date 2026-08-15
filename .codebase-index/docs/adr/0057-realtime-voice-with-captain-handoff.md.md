# docs/adr/0057-realtime-voice-with-captain-handoff.md

The realtime voice architecture: gpt-realtime
owns ears, mouth, and turn-taking in a Discord
call; the captain owns everything Clankie can do,
reached through exactly one tool (`ask_clankie`).
Supersedes ADR 0045's STT→captain→TTS cascade.

Read for the group-room design: two tiers
(dormant transcription session that answers
nothing; engaged session driven by explicit
`response.create`), a repo-owned floor state
machine instead of model turn detection,
engagement and release both downstream of one
volition question, speaker identity injected from
the authenticated gateway (never inferred from
audio), a bounded briefing so the fast path isn't
ignorant, phonetic name matching for wake, and
deliberate barge-in. Consequences: server-side
audio residency must be disclosed; cost becomes a
metered session.
