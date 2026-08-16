# apps/gba-mcp/package.json

Manifest for `@clankie/gba-mcp` (private,
ESM, exports `src/index.ts` directly — no
build output). Scripts: `start` runs the
stdio server via tsx, `probe` drives it as
a harness, plus typecheck/test/clean.

Depends on the workspace `gba-emulator`,
`interactive-environment`,
`possessor-voice`, and
`rendered-surface-client` packages, the MCP
SDK, and zod.
