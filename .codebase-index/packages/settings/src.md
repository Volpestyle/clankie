# packages/settings/src

Settings source: schemas, the store, persona
instruction composition, and the two env-resolve
modules that share one contract (env wins on
read, overrides reported, projection fills only
unset names).

- schema.ts — ClankieSettings (discord/persona/
  voice) + secret-shape write guard
- store.ts — SettingsStore, atomic 0600 writes
- persona.ts — registers → instruction text
- discord-resolve.ts — DISCORD_* env merge and
  projection
- voice-resolve.ts — CLANKIE_VOICE_* env merge
  and projection
- index.ts — barrel re-exports
