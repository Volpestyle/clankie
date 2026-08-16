# packages/environment-runtime

Durable single-writer lifecycle and lease enforcement for generic interactive environments. The runtime owns idempotent register-before-dispatch actions, pause/cancel/expiry/emergency fences, restart reconciliation, retention, redaction, and semantic events independently of any concrete game adapter.

- `package.json` — runtime dependencies and scripts.
- `README.md` — lifecycle, lease, persistence, and trust model.
- `src/` — public exports and runtime implementation.
- `test/` — lifecycle, restart, fencing, and retention tests.
- `tsconfig.json` — TypeScript configuration.
