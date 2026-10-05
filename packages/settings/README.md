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

This package stores **non-secret preferences and connection metadata**: persona,
Discord identifiers and allowlists, voice and game settings, runtime endpoints,
and coordinator references. Non-secret does not mean public: names, paths, and
account identifiers can still be private. Status views show the configuration
needed to operate the service; credentials stay in the broker.

Same directory, same permissions, different file, different rules:

|               | credential broker                    | settings            |
| ------------- | ------------------------------------ | ------------------- |
| Holds         | secrets                              | non-secret settings |
| Display       | redacted                             | plain               |
| macOS storage | Keychain                             | 0600 file           |
| Env supplied  | provider-specific compatibility only | **override wins**   |

The write path calls `assertNoSecretShapedValue` and refuses anything
token-shaped, so a secret cannot land here by accident. `.strict()` on the schema
is the first line of defence; the guard is depth for future free-text fields.

A missing settings file uses defaults. Invalid content, permission errors and
other read failures propagate; they never silently replace configured access
restrictions with defaults.

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

Use the matching TUI flow or headless CLI command: `/persona`, `/discord`,
`/voice`, `/connect`, `/games`, `/browser`, or `/connections`. Tokens and API
keys go to the broker. Non-secret configuration writes here. The [CLI reference](../../docs/cli.md)
owns command syntax; do not edit generated settings by hand.

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

`gameplay.pokeagentMmoEnabled` enables Clankie's credentialed seat in a hosted
PokeAgents world. The local emulator and `pokemonEmulatorEnabled` were retired;
older settings files have that key removed on read. Configure hosted play with
`clankie games set on|off` or `/games`
([ADR 0145](../../docs/adr/0145-the-world-is-the-only-body.md)).

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

## Execution connections

`execution.connections` stores up to 15 named Herdr endpoints with immutable
socket/session identity, enabled state, capacity and capability labels. The
default fleet keeps its existing `herdr` settings. Configure through the operator
API or `clankie runtime`; `/runtime` exposes the same commands. Connection IDs
cannot redirect retained work, and disconnect never stops the external runtime.
See [runtime commands](../../docs/cli.md#connections-and-runtime).

## Codex account homes

`codexAccounts` stores extra `{label, home}` records only. `default` remains implicit
from `CODEX_HOME` or `~/.codex`. The CLI/TUI and owner API register canonical paths;
Codex owns authentication and hook consent. `codexAccounts` and `codexAccountStatus`
supply the registry and saved rollout status. `readCodexAccountStatus` and
`selectLiveCodexAccount` query current quota through an owned Codex app-server
(no login or model turn), falling back to rollouts after a bounded failure.
Selection uses the minimum remaining fraction across reported windows, including
weekly-only plans. Hires and evals share that selector; session discovery uses
the registry. Unknown telemetry is not zero use.

## Projects

`projects` holds owner-authored project definitions and character role associations.
Roles, worker limits, workspace approvals and tool-policy references are never read
from repo-controlled configuration. A tracker reference points to an approved
workspace’s `.clankie/tracking.json`; it does not copy credentials or confer tool
authority. See [ADR 0216](../../docs/adr/0216-projects-own-agent-roles-and-tool-policy.md)
for canonical workspace matching, fail-closed ambiguity, durable legacy persona
migration and the default-project compatibility projection.

`projectsRevision` hashes the parsed project section. Future owner-authorized
editors compare `expectedRevision` inside `SettingsStore.update` and retain its
final authority guard. `resolveProjectMembership` only calculates policy from
host-established inputs; it cannot prove a pane, grant or caller’s identity.
Session-wide fleet grants remain unchanged here; VUH-1558 owns explicit retirement
and per-agent enforcement. No live migration runs as part of tests or build.

## Fleet responsibility

Global owner settings store `autonomy.fleet.closure` and
`autonomy.fleet.machineSetup`, both `lead` by default or `owner`. Project
`autonomy.fleet` leaves are optional and inherit independently; a null patch
removes only one override. The logical CLI/API fleet view places them beside
size/models. Configure through `clankie fleet set` and `clankie project settings`,
not direct file edits. See [ADR 0227](../../docs/adr/0227-fleet-responsibility-is-owner-settings.md)
for responsibility, owner-only boundaries and future envelope alignment.
