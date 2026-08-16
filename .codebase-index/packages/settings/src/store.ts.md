# packages/settings/src/store.ts

`SettingsStore` — load/update for the settings
file. `defaultSettingsPath` is
`${XDG_CONFIG_HOME:-~/.config}/clankie/settings.json`
(`CLANKIE_SETTINGS_FILE` overrides), beside the
broker's credentials file so the operator has one
place to look.

`load()` returns defaults when the file is
absent, but a malformed file fails loudly —
silently reverting to defaults would quietly
widen an allowlist the operator narrowed.
`update(mutate)` runs load → mutate → schema
parse → `assertNoSecretShapedValue` → atomic
persist (temp + rename, 0600 file in a 0700
dir), serialized through an in-process promise
queue so concurrent updates both land.
