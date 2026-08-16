# packages/credential-broker/src

Credential stores, account providers, OAuth, HMAC capability tokens, and typed local bearer modules. Internal principals share `stored-bearer.ts` for entropy, validation, bootstrap, and failure semantics while retaining distinct prefixes/provider IDs and forbidden-environment rules.

- `activity-producer-credential.ts` — private Activity frame principal.
- `capability-token.ts` — bounded signed grant primitive.
- `captain-credential.ts` — captain dispatch bearer.
- `credential-store.ts` — Keychain/file stores and redaction.
- `discord-bot-provider.ts` — official bot account grants.
- `discord-bridge-credential.ts` — four separate Discord lane bearers.
- `discord-user-session-provider.ts` — lab user credential and durable opt-in grants.
- `index.ts` — public package exports.
- `linear-oauth.ts` — Linear dynamic registration and OAuth/PKCE.
- `operator-credential.ts` — local operator bearer inspection/rotation.
- `possessor-voice-credential.ts` — gameplay voice seam bearer.
- `runner-credential.ts` — embodiment runner bearer.
- `stored-bearer.ts` — shared minted-bearer implementation.
