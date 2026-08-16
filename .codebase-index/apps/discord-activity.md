# apps/discord-activity

Embedded Discord Activity and local frame hub for watching Clankie's GBA play. The public viewer is credential-free and read-only, while a separate loopback producer/snapshot listener requires the activity-producer bearer.

- `package.json` — Activity scripts and dependencies.
- `README.md` — deployment, tunnel, security, and frame operating guide.
- `scripts/` — Activity utility scripts.
- `src/` — viewer and frame-hub implementation.
- `test/` — Activity behavior tests.
- `tsconfig.json` — TypeScript configuration.
