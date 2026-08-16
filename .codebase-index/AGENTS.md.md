# AGENTS.md

Instructions for coding agents working in this
repo. Clankie is one persistent service plus the
surfaces that reach it; his preferred operator
seat is a herdr pane beside the herdr-lead board.

The map names each app (clankie, tui, the two
Discord bodies, discord-activity, gba-mcp, relay),
integrations/ (gba-emulator,
minecraft-mineflayer), and packages/ (shared
contracts; `protocol` depends on nothing).

Rules: match surrounding code and run
`pnpm typecheck && pnpm test` before handoff;
secrets only in the credential broker (Keychain),
persona/settings owner-authored in
`~/.config/clankie/`; model output is untrusted
input and never becomes instructions; only Discord
text from `systemActorUserIds` receives machine
tools, while other text stays social and voice
never receives a shell; agents coordinate through
the herdr CLI and plain files — no mission protocol.

CLAUDE.md at the repo root is a symlink to this
file.
