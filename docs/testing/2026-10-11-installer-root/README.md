# VUH-2127 installer root isolation

Base: `4ffbc7eb3cfb684258643e47afc67e5f3ab4dce8` (fetched origin/main).

Ran the modified real `install.sh --version v0.4.4 --no-app` through
`clankie heavy`, downloading the published archive and SHA-256 file from GitHub.
HOME, XDG config/state, install root and bin directory were temporary;
CLAUDE_CONFIG_DIR, CODEX_HOME, CLANKIE_STATE and CLANKIE_SETTINGS_FILE were unset.
PATH modification was disabled. No live profiles were relinked at any point.

Observed: checksum OK, app skipped, installation successful, explicit
`Skipped harness linking: non-default install root` message, and native launcher
reported `clankie 0.4.4`. No service was started on this macOS proof.

SHA-256 of every live `~/.claude*/plugins/known_marketplaces.json`, captured
before and after the installer, was identical:

- `/Users/james/.claude-cc/plugins/known_marketplaces.json`: `333245d2d6fd8a9044a14f5012dd4f3583f239cdfc1e719e5e9279b876645821`
- `/Users/james/.claude-james/plugins/known_marketplaces.json`: `22bd786850b99d7f2aa886c964533a37ffaa8b5704ff21ff0ffd25d73dbd604b`
- `/Users/james/.claude/plugins/known_marketplaces.json`: `c2ce1695575d64691566038b4849900694abb5478bc6c97cd194d8c3b07451e8`

Focused check: `clankie heavy -- pnpm exec vitest run apps/tui/test/installer.test.ts`
passed (1 file, 1 test). It runs the real shell installer, tar and checksums with
fixture downloads and a recording launcher: default-root installs dispatch
`harness install --refresh-linked`; custom-root installs dispatch no harness
commands. This verifies default dispatch, not real native profile mutation.

Formatter ran on touched files (oxfmt excludes shell); `sh -n install.sh` passed.
Raw installer log and hash manifests: `.local/vuh-2127/` in the task checkout.
