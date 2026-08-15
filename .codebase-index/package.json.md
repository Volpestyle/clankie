# package.json

Root manifest of the pnpm/turbo monorepo
(`clankie`, private, ESM, Node >=24,
pnpm@11.11.0). Holds only repo-wide dev tooling
and the script entry points; workspace packages
carry their own deps.

Scripts:

- dev/build/typecheck fan out through turbo;
  `test` runs vitest once from the root config.
- `lint` = oxlint --deny-warnings, `fmt` = oxfmt,
  `docs:check` = scripts/check-doc-links.mjs.
- `check` chains fmt:check, lint, docs:check,
  typecheck, test — the pre-handoff gate.
- `doctor` (scripts/doctor.mjs) and `cli:install`
  (scripts/install-cli.mjs) for setup.
- Convenience filters: `gba:free-play`,
  `gba:free-play-live`, `gba:mcp-probe`,
  `discord:readiness`, `discord:voice-readiness`,
  `minecraft:readiness`,
  `minecraft:paper:bootstrap`.
- `clean` wipes turbo caches plus .turbo/.data.

Dev deps: typescript 5.9, vitest 4, oxlint,
oxfmt, turbo 2.10, tsx, @types/node.
