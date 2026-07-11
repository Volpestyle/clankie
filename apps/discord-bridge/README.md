# Discord bridge

Official Discord application/bot integration only. Do not automate a normal Discord user account or accept user-account credentials.

The V1 bridge uses slash commands and explicit `/captain-join` / `/captain-leave` voice consent. Audio transcription, speaker memory, and retention are intentionally absent until their disclosure, consent, deletion, and visibility policies are implemented.

Required environment variables:

```bash
DISCORD_BOT_TOKEN=...
DISCORD_APPLICATION_ID=...
DISCORD_GUILD_ID=...          # optional, faster command registration in development
SAPLING_API_URL=http://127.0.0.1:4310
```

The bridge is a channel adapter. It never owns mission state, model credentials, or merge authority.
