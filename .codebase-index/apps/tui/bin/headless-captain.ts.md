# apps/tui/bin/headless-captain.ts

Dispatcher for every non-interactive `clankie`
subcommand: `health`/`status`, `restart`, `down`,
`trace`, `pair`, `devices`, `operator-credential
rotate`, `play status|stop`, and help. Exports
`isHeadlessCaptainCommand`,
`runHeadlessCaptainCommand`, and `processTraceStream`
plus the cursor-path helpers. Every command takes an
options bag full of test seams (fetch, spawn, kill,
process-table scan, credential stores, sleep).

Details:

- `health` inspects the operator credential and all
  services in `SERVICE_ORDER`; healthy means the
  clankie service probe passes and the credential is
  present and consistent. Exit 0/1.
- `restart`/`down` resolve targets through
  `services.ts` and print outcome lines plus JSON.
- `trace` is render-only: resumes an identity-only
  `TraceCursor` (adopting the headless session id
  when generations match), streams events through
  `processTraceStream` → `renderTraceEvent`, and
  reconnects across turn boundaries. The pi service
  exposes no session stream yet, so the default
  client (`unavailableTraceClient`) throws a plain
  explanation; a live transport plugs into
  `clientFactory`. Reports pane status via
  herdr-report; `--timeout` exits 124.
- `pair` renders a one-time QR (qrcode terminal
  mode) + code + deep link; `--json` emits the offer
  fields instead.
- `play` hits `/v1/embodiment/sessions/live`
  (status) and `.../live/stop` (graceful stop at the
  next turn boundary; 404 means nothing playing).
- The captain token is minted on first run
  (`ensureCaptainCredential`) but its absence
  degrades a restart rather than failing it.
