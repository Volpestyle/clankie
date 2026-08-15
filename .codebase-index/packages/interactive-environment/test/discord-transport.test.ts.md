# packages/interactive-environment/test/discord-transport.test.ts

Discord transport-binding suite. Covers: the
ordinary social catalog (reply/react/send/typing/
voice_join) available on both bodies; embedded
activities bot-only and Go Live user_session-only;
exactly one deduplicated transport list per
catalog entry; `discordPresenceLaneAddress`
deriving one lane per channel (`discord:guild:
channel`, `discord:dm:channel`) so a body swap
continues the same conversation; and voice rooms —
named rooms parse when they mirror voiceGuildIds
exactly (optional for old records), and diverging
membership or order is rejected.
