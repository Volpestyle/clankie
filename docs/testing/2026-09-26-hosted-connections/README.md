# Hosted account connections, body side (ADR 0196, VUH-1383 slice 1)

Proof, 2026-09-26, that a body with no `gh` login links the owner's GitHub
account through a device flow, keeps the token only in its credential broker,
uses it for the ADR 0191 work tracker, and revokes it on disconnect.

**How it ran.** `flows/serve.mts` starts a throwaway hosted-body stand-in: the
real `/v1/accounts` and `/v1/work` routes, a real file credential broker in a
temp directory, the work-items service with `hosted: true` (no `gh`
fallback), and a **fake GitHub** on loopback (device flow, `/user`, grant
revocation, issues). No real GitHub or Linear was called, no OAuth app exists
yet, and the owner's running service was not restarted. `flows/run.sh` drove
the real `clankie accounts` and `clankie work` CLI against it, then scanned
every output for the token. Everything in `evidence/` is sample data: the
account `proof-owner`, the repo `proof/repo` and the token are fakes.

## Results (evidence/)

| Step  | What it proves                                                                                                                                                                                                                           |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01    | A repo recorded as GitHub-tracked (`proof/repo`).                                                                                                                                                                                        |
| 02    | Before connecting: GitHub `not_connected` (a client ID is configured), Linear `unconfigured` (no redirect URI set).                                                                                                                      |
| 03    | Without a connection the work tracker says `connect GitHub to Clankie to use it`, and never tries `gh`.                                                                                                                                  |
| 04    | `clankie accounts connect github` printed the user code (`04-connect.stderr`), polled at GitHub's interval through one `authorization_pending`, and returned the connection: account, `repo` scope, since, where to manage it. No token. |
| 05    | The list shows the connection the same way.                                                                                                                                                                                              |
| 06–07 | The work tracker created and listed issue `#1` through the REST API with the connection token (`service.stderr` shows the fake GitHub's requests).                                                                                       |
| 08–09 | The broker file holds the token once, beside its scopes, login and client ID (values redacted in the copy).                                                                                                                              |
| 10    | Disconnect revoked the grant (`DELETE /applications/{client_id}/grant` with the app secret) and returned `revoked: true`.                                                                                                                |
| 11–12 | After disconnect the connection is gone and the work tracker is back to "connect GitHub".                                                                                                                                                |
| 13    | The token, the app secret and the device code appear in none of the evidence files, including every CLI output, the service's stdout/stderr and its event log.                                                                           |

## Automated tests

`pnpm check` passed on the change (see the finish report for counts). The
focused suites:

- `apps/clankie/test/accounts.test.ts` (12): a fake GitHub device-flow server
  for the happy path, an expired code (from GitHub and from the flow's own
  clock), a denied request with `slow_down`, revocation with and without the
  app secret, `unconfigured`; Linear PKCE start, single-use complete, bad code,
  RFC 7009 revocation; authority (owner or Take Control only); a redaction
  test that drives token-echoing provider errors and a failing broker, then
  checks responses, body logs, the event log, the telemetry spool and stderr.
  The same file proves the work tracker on a hosted body with and without a
  connection.
- `apps/clankie/test/gateway-encryption.test.ts`: the Linear code crosses the
  public gateway only inside the encrypted envelope; plaintext is refused
  (426); Supervise is refused, Take Control accepted.
- `packages/work-items/test/backends.test.ts`: the REST client follows
  pagination only on the API origin and its errors carry no token.
- `apps/tui/test/accounts-command.test.ts`: the CLI's client settings and its
  device-flow loop.

## Not proven here

- Real GitHub and Linear: no OAuth apps are registered yet, and the task
  forbids calling them. Linear's `revocation_endpoint` discovery and dynamic
  registration against the real `mcp.linear.app` are unverified.
- The app and account-page screens (the next slice).
- A real hosted body: the stand-in runs the same routes and services with
  `hosted: true`, not the provisioned image.
