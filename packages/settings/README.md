# @clankie/settings

Operator-facing **non-secret** configuration, stored at
`${XDG_CONFIG_HOME:-~/.config}/clankie/settings.json` (mode 0600, directory 0700).

## Why this is not the credential broker

[`@clankie/credential-broker`](../credential-broker/README.md) stores values that
**grant access**: it uses the macOS Keychain, redacts everything on display, and
validates typed token patterns. The broker is canonical; some model/media
providers retain compatibility API-key environment fallbacks, while Discord
account tokens and broker-only body bearers reject environment copies.
Operator and captain bearers retain explicit test/CI overrides.
The [credential guide](../../docs/credentials.md) lists the concrete account and
local bearer identities.

This package stores values that are **public identifiers** — application ids,
guild and channel ids, role ids, allowlists, booleans. An operator reads them off
the Discord UI and legitimately wants to see them plainly when checking their
config, so broker redaction would hide exactly what makes settings useful.

Same directory, same permissions, different file, different rules:

|               | credential broker                    | settings           |
| ------------- | ------------------------------------ | ------------------ |
| Holds         | secrets                              | public identifiers |
| Display       | redacted                             | plain              |
| macOS storage | Keychain                             | 0600 file          |
| Env supplied  | provider-specific compatibility only | **override wins**  |

The write path calls `assertNoSecretShapedValue` and refuses anything
token-shaped, so a secret cannot land here by accident. `.strict()` on the schema
is the first line of defence; the guard is depth for future free-text fields.

## Environment precedence

`resolveDiscordSettings(stored, env)` merges the two with **environment winning**.
These are non-secret operational overrides for CI, one-off runs, and containers;
they are separate from provider credential fallback behavior.

Every override is reported in `overriddenByEnvironment` so the TUI can show _why_
a stored value is not the effective one. A silent override is the kind of thing
that costs an hour of debugging.

`discordSettingsToEnvironment(settings)` projects back into the variable names
the bridge and the clankie service already read, so adopting the store is a
composition change rather than a rewrite of every call site. Disabled flags are
omitted rather than emitted as `"false"`, so a stale export cannot accidentally
enable a plane.

## Editing

Use `/discord`, `/voice`, `/connect`, or `/games` in the Clankie TUI. Tokens and API keys
go to the credential broker (same destination as `/auth`). Public identifiers —
Discord ids, an IMAP host and username, MCP server commands and URLs — and
gameplay enablement write here.

`voice.realtimeProvider` selects `openai` or `xai`. Provider-specific model and
voice fields are retained when switching, so trying Grok does not erase the
OpenAI setup. The active values project to `CLANKIE_VOICE_REALTIME_*`; xAI's
reasoning effort projects separately. xAI streaming STT has no model selector,
while OpenAI keeps its configurable transcription model. Secrets entered in
`/voice` go directly to the credential broker and never enter this schema.

`discord.voiceTranscriptLoggingEnabled` is the explicit development switch for
exact consented Discord voice text. It is off by default and projects to
`DISCORD_VOICE_TRANSCRIPT_LOGGING_ENABLED`; the private transcript file stays
separate from content-free receipts. Configure it in `/discord` beside the
voice consent policy.

`mcp.servers` is the owner's MCP servers ([ADR 0109](../../docs/adr/0109-mcp-is-how-he-reaches-a-service.md)).
Connectors Clankie ships knowing about — Linear — need no entry; connecting the
credential is enough. Each entry names a `credential` by **broker provider id**,
never a secret, and declares a `lane`: `operator` (the default) keeps the server
at the console, `everywhere` opens it to every room he is in. `initialTools`
narrows which of a large server's tools start active; the rest stay one
`mcp_tool_search` away.

A top-level section this version has retired is dropped when the file is read,
so an older settings file still opens. Any _other_ unknown key is still a hard
parse failure, which is how a typo stays visible.

`gameplay.pokemonEmulatorEnabled` controls solo FireRed/Emerald through the
local GBA emulator. `gameplay.pokeagentMmoEnabled` independently controls the
hosted PokeAgent MMO. Both may be enabled, while the shared play host permits
one live session across them.

`/discord status` prints the effective configuration, whether `discord_bot` is
present in the broker, and any environment overrides in effect.

`discord.activeBody` is which Discord process is the mouth (`bot` or
`user_session`, default `bot`). Both tokens stay stored; the launcher starts
only the active one.

`discord.userSessionEnabled` is the lab user body that can watch shares and
Go Live. It is off by default and still needs a stored `discord_user_session`
token, allowlists, the durable opt-in, and `activeBody=user_session` before
the launcher starts it.

`discord.systemActorUserIds` is the Discord users whose text turns get bash,
files, and herdr. Empty means nobody — Discord stays social. It is not
`ownerUserId` (DM policy) and not `ambientUserIds` (slash commands).

`discord.toolProgressChannelIds` is the guild channels where requested text
turns show the content-free tool-activity card. It is empty by default and the
owner changes it in Discord with `/clankie tools mode:on|off|status`.
