# apps/discord-bridge/test/voice-composition.test.ts

Covers the offline voice composition: env parsing
(documented defaults, ElevenLabs provider rules,
override bounds, rejection of unbounded idle/
truncation and retired cascade knobs); the
volition decider (bounded room text, temperature
0, strict yes, fails closed, refuses non-HTTPS
endpoints); evidence→receipt mapping and the
per-turn response line (wake class, narration vs
room trigger, back-compat for pre-trigger
records); idle auto-leave arming/disarming; and
the disclosure/status wording — live-session
residency stated, per-turn discard never
promised, second vendor disclosed under
ElevenLabs.
