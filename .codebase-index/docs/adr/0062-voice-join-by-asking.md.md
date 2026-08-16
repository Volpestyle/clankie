# docs/adr/0062-voice-join-by-asking.md

Natural-language voice join/leave is an authored
captain action, not a phrase matcher or separate
intent model. Argument-free `voice_join` /
`voice_leave` tools use host-stamped actor/guild
context; the active Discord body resolves the
actor's fresh channel, applies its own allowlists
and authority, and returns a typed result.

The same grounding pattern covers reactions,
threads, and live-watch actions: the model never
chooses raw user, guild, channel, or message ids.
Consent stays separate; bot joins opt in nobody,
while the owner-only lab body discloses and records
its automatic owner capture.
