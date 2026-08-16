# scripts

Standalone Node utilities used by root package scripts for repository hygiene and local setup. They use Node built-ins and require no separate build step.

- `check-doc-links.mjs` — validates tracked Markdown relative links for `pnpm docs:check`.
- `doctor.mjs` — reports toolchain, optional media tool, broker, Vox, and launcher readiness.
- `install-cli.mjs` — installs the `clankie` launcher symlink under the user's local bin directory.
