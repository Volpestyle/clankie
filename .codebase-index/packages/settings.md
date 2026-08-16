# packages/settings

Owner-authored non-secret configuration and persona settings stored in a private JSON file. It validates token-shaped-value exclusion, merges environment overrides for operational coordinates, and supplies model, Discord, voice, Linear, email, and persona configuration to apps.

- `package.json` — settings dependencies and scripts.
- `README.md` — storage and broker separation guide.
- `src/` — schemas, stores, environment merging, and persona helpers.
- `test/` — validation and override tests.
- `tsconfig.json` — TypeScript configuration.
