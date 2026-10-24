# VUH-2558 — core reporting half

[Issue](https://linear.app/vuhlp/issue/VUH-2558). Core base `005b72eeaa8851bc9f311317ba448c0ca9c2b728`.

Paired devices POST strict, content-free rolling timing summaries to
`/v1/devices/self/app-metrics`. Device identity comes from the authenticated
session. Operator `clankie metrics --app` reads separate device/platform windows.
Reports cap at 4 KiB, eight destinations and 64 samples per destination; the
service keeps at most 64 snapshots, throttles updates to one/second, expires
idle snapshots after an hour, and excludes revoked/expired automation devices.
Client snapshots replace their predecessor; percentiles are never averaged.

Real HTTP pairing → POST → API-client/CLI reads pass. The source CLI executable
also returned the expected report from an actual paired HTTP session. That
standalone proof used **synthetic** timing inputs (Work p50 24ms / p95 140ms,
long-task p50 0ms / p95 95ms, 12 samples / two slow switches); it does not claim
native measurements. The app half owes Mac/iPhone Release and idle CPU proof.

The two new integration tests fail with the old route wiring (404), then pass
with the new route. They verify auth separation, schema/size rejection,
replacement, throttling, revocation, per-platform separation, bounded eviction,
TTL while an ordinary fixture pairing remains active, and reset on restart.
The fixture service and its ephemeral pairings are removed in teardown.

Checks: 22 focused tests pass. Root `check:landing`: **989 files / 8,565 tests
passed**, 38 files / 99 tests skipped; formatting, lint, public docs and
TypeScript pass. Exit **3** is the pending standing review gate. Earlier gate
attempts caught a fixture lint warning and missing public route docs; both fixed.

[Root gate log](clankie://evidence/sha256/17d4822c0d2da6b5e7bba205236cdc820386d0b9263fcd93a2b59b7b212da94d) is listed in `evidence.json`. Source CLI and test fixtures ran
against isolated loopback hosts, with no owner service restart or model eval.
