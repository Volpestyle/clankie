# integrations/gba-emulator/src/free-play-bounds.ts

Bounds on the model text free play produces,
split into their own module because Voice
needs them and the loop imports Voice (keeping
them in free-play.ts made a real import
cycle).

Constants: monologue 600, intent 200, notes
800 (a cap forces him to keep what matters),
objective 160, interjection 500, reply 2000
(Discord's limit), speak 400, and
`FREE_PLAY_SPEAK_COOLDOWN_TURNS = 4` — a rate
gate, deliberately not a content rule; the
gate is the ceiling so the prompt is free to
invite speech.
