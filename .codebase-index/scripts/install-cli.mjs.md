# scripts/install-cli.mjs

Launcher installer run as `pnpm cli:install`.
Marks apps/tui/bin/clankie.ts executable and
symlinks it to ~/.local/bin/clankie, creating the
bin directory if needed.

Safety and UX details: refuses to replace an
existing non-symlink file at the link path
(exits 1), silently replaces an existing symlink,
warns if apps/tui/node_modules is missing (run
pnpm install first) and if ~/.local/bin is not on
PATH.
