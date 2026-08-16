# integrations/gba-emulator/src/free-play-voice.ts

The half of Clankie that talks, split from the
player because speech sharing a call with the
game measurably lost (at most 1 remark in 16
turns). Voice decides only whether to speak;
it is handed no controller, which makes "an
interjection cannot become a route" structural
rather than prompt wording.

Exports `VoiceDecisionSchema` (speak/reply,
both `.nullable()` — never `.nullish()`,
because OpenAI structured output requires
every key in `required`), the `VoiceView`
(monologue, effect, intent, objective, what
was heard, audience, recent remarks — no
action surface), `VOICE_SYSTEM_PROMPT` (voice
the player's real thoughts, don't narrate the
screen, silence is a real answer),
`renderVoiceView`, and
`voiceHasSomethingToConsider` — a cost gate
that skips the model call when nobody spoke
and nothing changed.
