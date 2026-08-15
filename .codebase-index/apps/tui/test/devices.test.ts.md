# apps/tui/test/devices.test.ts

`clankie devices` list/revoke through
`runHeadlessCaptainCommand` with a fake fetch and an
in-memory credential store: table and `--json`
output, grant summaries, and every fail-closed
status (unauthorized without a credential, 404 →
not_found, malformed payloads, unreachable service)
with secret-free messages.
