# @clankie/settings

Operator-facing **non-secret** configuration, stored at
`${XDG_CONFIG_HOME:-~/.config}/clankie/settings.json` (mode 0600, directory 0700).

## Why this is not the credential broker

[`@clankie/credential-broker`](../credential-broker/README.md) stores values that
**grant access**: it uses the macOS Keychain, redacts everything on display, and
validates typed token patterns. Environment-supplied secrets are hard startup
errors.

This package stores values that are **public identifiers** — application ids,
guild and channel ids, role ids, allowlists, booleans. An operator reads them off
the Discord UI and legitimately wants to see them plainly when checking their
config, so broker redaction would hide exactly what makes settings useful.

Same directory, same permissions, different file, different rules:

|               | credential broker | settings           |
| ------------- | ----------------- | ------------------ |
| Holds         | secrets           | public identifiers |
| Display       | redacted          | plain              |
| macOS storage | Keychain          | 0600 file          |
| Env supplied  | hard error        | **override wins**  |

The write path calls `assertNoSecretShapedValue` and refuses anything
token-shaped, so a secret cannot land here by accident. `.strict()` on the schema
is the first line of defence; the guard is depth for future free-text fields.

## Environment precedence

`resolveDiscordSettings(stored, env)` merges the two with **environment winning**,
the opposite of the broker's rule. A leaked secret is a security failure; an
overridable non-secret is an operational convenience that keeps CI, one-off runs,
and containers working without a settings file.

Every override is reported in `overriddenByEnvironment` so the TUI can show _why_
a stored value is not the effective one. A silent override is the kind of thing
that costs an hour of debugging.

`discordSettingsToEnvironment(settings)` projects back into the variable names
the bridge and the clankie service already read, so adopting the store is a
composition change rather than a rewrite of every call site. Disabled flags are
omitted rather than emitted as `"false"`, so a stale export cannot accidentally
enable a plane.

## Editing

Use `/discord` in the Clankie TUI. It writes to **both stores**: its **Tokens**
step stores secrets in the credential broker (same destination as `/auth`), and
every other step writes here.

`/discord status` prints the effective configuration, whether `discord_bot` is
present in the broker, and any environment overrides in effect.
