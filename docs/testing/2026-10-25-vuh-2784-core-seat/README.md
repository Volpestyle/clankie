# VUH-2784: own-seat control core proof

2026-10-25, built from fetched `origin/main` `2235beb2e` in the owned
`feat/vuh-2784-onboarding` core worktree. This is core integration evidence;
the fresh-profile desktop walkthrough remains separate app acceptance.

## Verified

- The source `clankie seat show` executable reaches a real loopback owner API.
- CLI selection persists through the real SettingsStore without changing the
  worker harness preference. An app start creates a separate ready chat.
- Claude and Codex starts each create one fresh tab through a private real
  Herdr daemon and the production native `layout.apply` transport. Real child
  processes record their exact `clankie HARNESS --conversation ID` argv.
  Existing panes retain identity, content revision and working directory;
  the new tab receives focus.
- Concurrent duplicate start requests and a service-controller restart retain
  the original request. A lost reply after actual pane creation stays
  uncertain and never launches a second pane.
- An unverified native source does not count as ready for a requested harness.
  The existing native channel integration proves a bound Claude source is
  ready for Claude and refused for Codex.
- The actual relay/device/service HTTP path keeps the original Take Control
  device bearer. Chat-only, steer-only, revoked, malformed, stale and
  unsupported requests are refused before launch effects. The native launcher
  also rechecks authority after resolving its Herdr binding.

## Checks

All builds/checks ran through `clankie heavy --`:

```text
node_modules/.bin/tsc --noEmit -p apps/clankie/tsconfig.json
node_modules/.bin/vitest run apps/clankie/test/captain-seat.integration.test.ts apps/relay/test/fleet-settings-roundtrip.integration.test.ts
node_modules/.bin/vitest run apps/clankie/test/lead-messages.integration.test.ts -t 'a lead messages another lead'
node_modules/.bin/vitest run apps/clankie/test/captain-seat.integration.test.ts
```

Typecheck passed. `focused.log` records 12 passing tests; `native-readiness.log`
records 2 passing selected native-channel cases (13 unrelated cases skipped).
`cli-native-launch.log` records the final 2 passing seat cases, including the
real source CLI executable. The `verification.txt` evidence-store bundle includes those exact logs and
the exercised producer/consumer sources.

## Limits

The terminal executable in the private Herdr fixture records argv; it is not
a vendor model session. No live account, subscription, settings, existing
agent lane or installed service was changed or restarted. Real vendor sign-in,
a model response, and the desktop walkthrough remain unproven by this core
fixture. The root landing gate and exact review/landing SHA are recorded on
VUH-2784 when they complete.
