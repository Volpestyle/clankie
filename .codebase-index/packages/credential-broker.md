# packages/credential-broker

Canonical local secret boundary using macOS Keychain by default with a private file fallback for supported environments. It stores provider/account credentials and minted Clankie principal bearers, validates short-lived HMAC capability tokens, and implements Linear OAuth without exposing secret material to settings, models, or logs.

- `package.json` — broker dependencies and scripts.
- `README.md` — storage, identity, fallback, OAuth, and capability guidance.
- `src/` — stores, providers, OAuth, token signing, and bearer modules.
- `test/` — storage, provider, bearer, OAuth, and token tests.
- `tsconfig.json` — TypeScript configuration.
