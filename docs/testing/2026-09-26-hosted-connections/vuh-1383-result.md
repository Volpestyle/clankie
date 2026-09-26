# VUH-1383 result comment (for the lead to post)

**Slice 1: the body side is in `c206c18e` (clankie local main, not pushed).**

A hosted body can now link its owner's GitHub and Linear accounts. The token lives only in the body's credential broker, and the ADR 0191 work tracker uses it.

- **Decision record:** [ADR 0196](docs/adr/0196-account-connections-keep-tokens-on-the-body.md) (proposed) covers:
  - each provider's flow (a GitHub device flow; Linear OAuth with PKCE and a sealed hand-off)
  - where tokens live (broker only), scopes (GitHub `repo`, Linear `read write`), revocation, and what the fleet may see (nothing)
- **API:** `/v1/accounts` list, `github/start`, `github/poll`, `linear/start`, `linear/complete`, `disconnect`.
  - Access is the owner operator or a Take Control device, and remote calls must use the encrypted envelope.
  - Results are closed codes only. Nothing is logged and no telemetry is emitted.
- **CLI:** `clankie accounts [list] | connect github | disconnect github|linear | apps set|clear …`.
- **Client IDs:** owner-set in settings (`oauthApps`), with environment overrides for hosted bodies.
- **Work tracker:** on a hosted body, the GitHub backend uses the connection token over REST and never uses `gh`. Without a connection it says "connect GitHub to Clankie". Linear already works on a hosted body through the `linear` broker entry.

**Evidence:** `docs/testing/2026-09-26-hosted-connections/`. The real `clankie accounts` and `clankie work` CLI ran against the real routes with `hosted: true` and a fake GitHub:

- connect via device code
- create and list an issue with the token
- disconnect, which revoked the grant
- a redaction scan of every output, the service logs and the event log came back clean

Tests (all fakes):

- `accounts.test.ts` 12/12: happy path, expired, denied/slow_down, revocation with and without the app secret, Linear PKCE, authority, and redaction across responses, logs, event log, telemetry and stderr
- the gateway-encryption envelope case
- a REST client test showing pagination stays on the API origin
- CLI tests

`pnpm check` is green: 323 files, 2687 tests passed, 1 skipped.

**Not proven:** real GitHub and Linear. No apps are registered and none were called. Linear's dynamic registration and `revocation_endpoint` discovery against the real `mcp.linear.app` are also unverified.

## Next: the app/account-page slice needs to supply

1. A Connections screen (iPhone, iPad, macOS) and an account-page section:
   - `GET /v1/accounts` rows: status, account, scopes, `manageUrl`
   - disconnect, and show `manageUrl` when `revoked: false`
2. GitHub connect: call start, show `userCode` and open `verificationUri`, then poll at `interval` until connected, `expired` or `denied`.
3. Linear connect: call start and open `authorizeUrl` in ASWebAuthenticationSession. Catch the redirect, then POST `{state, code}` to `/linear/complete` inside the encrypted envelope.
4. Pairing must accept Take Control (same as model keys).
5. The account-page flows go through the same encrypted device path, never the gateway in plaintext.

## Next: James must supply

1. A GitHub OAuth app with device flow enabled (or a GitHub App with Issues permission), and its client ID set in `CLANKIE_GITHUB_OAUTH_CLIENT_ID` or `clankie accounts apps set`.
2. Whether hosted bodies receive the GitHub app's client secret (broker `github-oauth-app`). Without it, disconnect deletes the token locally but cannot revoke it at GitHub.
3. The Linear redirect URI the app catches (a universal link or `clankie://`). Also: keep dynamic registration, or register a Linear OAuth app and set its client ID.
4. Accepting ADR 0196 (it is currently proposed).
