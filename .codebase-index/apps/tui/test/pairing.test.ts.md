# apps/tui/test/pairing.test.ts

`clankie pair` through the headless dispatcher with
fake fetch and in-memory credential stores: QR/code/
deep-link rendering, `--json` output, expiry
detection, and every fail-closed status (unavailable,
unauthorized, expired, consumed, revoked, malformed,
interrupted) with secret-free messages. Also covers
`operator-credential rotate` and
`isHeadlessCaptainCommand`.
