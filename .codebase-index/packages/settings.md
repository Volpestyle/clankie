# packages/settings

`@clankie/settings` — operator-facing **non-secret**
configuration, stored at
`~/.config/clankie/settings.json` (0600 file, 0700
dir). Holds public identifiers only: Discord
application/guild/channel/role ids and allowlists,
persona (who Clankie is and how he talks), and
voice/TTS selection, plus public Linear default-
team and email host/user coordinates. The
deliberate opposite of
the credential broker: displayed plainly, and the
environment _overrides_ the store.

Children:

- README.md — the settings-vs-broker split and
  the env precedence rules
- package.json / tsconfig.json — zod-only, ESM
- src/
  - schema.ts — Discord/persona/voice schemas +
    Linear/email schemas + the token-shape write
    guard
  - store.ts — atomic 0600 SettingsStore
  - persona.ts — register-layer instruction
    composition
  - discord-resolve.ts — env-wins merge and the
    env-projection adoption seam; active-body
    parsing
  - voice-resolve.ts — same contract for
    `CLANKIE_VOICE_*`
  - index.ts — barrel
- test/ — store/resolve and persona suites

Key invariant: `assertNoSecretShapedValue` runs
on every write, so a token-shaped string can
never land in the plainly displayed file; secrets
belong to the credential broker.
