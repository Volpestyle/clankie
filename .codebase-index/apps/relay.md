# apps/relay

HTTP-only remote operator-conversation boundary for phone and desktop clients. It authorizes every JSON/NDJSON request against the service's live device-session projection and forwards upstream with a separate captain credential; no local-development WebSocket, terminal plane, or PTY tunnel remains.

- `package.json` — relay scripts and development toolchain.
- `README.md` — authorization, redaction, transport, and configuration guide.
- `src/` — device auth, upstream dispatch, HTTP router, and conversation handler.
- `test/` — HTTP conversation fixtures and behavior tests.
- `tsconfig.json` — TypeScript configuration.
