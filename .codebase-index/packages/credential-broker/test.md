# packages/credential-broker/test

Tests for Keychain/file semantics, token redaction and signing, account grant providers, every principal bearer, operator consistency/rotation, Linear OAuth, and the bounded capability-token primitive.

- `activity-producer-credential.test.ts` — Activity bearer lifecycle.
- `captain-credential.test.ts` — captain bearer behavior.
- `credential-broker.test.ts` — capability-token validity and resource scope.
- `credential-store.test.ts` — store and redaction behavior.
- `discord-bot-provider.test.ts` — official bot grants.
- `discord-bridge-credential.test.ts` — Discord lane bearer separation.
- `discord-user-session-provider.test.ts` — user credential and opt-in rules.
- `linear-oauth.test.ts` — OAuth/PKCE flows.
- `operator-credential.test.ts` — operator inspection and rotation.
- `runner-credential.test.ts` — runner bearer behavior.
