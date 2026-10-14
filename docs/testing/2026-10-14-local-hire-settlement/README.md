# VUH-2243 local hire settlement

An uncertain local hire receipt had no settle path: every disposition needed a
remote host reservation or recovery journal. `abandoned` now settles a local
receipt from this Mac's complete Herdr inventory when its original pane is
absent or holds only its own shell.

## Native proof

`local-hire-settlement-native.integration.test.ts` runs a real isolated Herdr
daemon with real panes, shells and foreground processes. It restores the live
`pet3d-spike` receipt (`1ad7ec41…`, `fixtures/hire-receipts/local-uncertain-hire.json`),
translating only its directory and pane. `abandon/results.json` retains each phase:

- a later hire into the directory is held `delivery_unconfirmed` (the live failure);
- `not-launched` refuses a local receipt;
- a `sleep` foreground process and a reported Claude session each refuse;
- the shell-only pane settles with its shell PID, and repeating it returns the same evidence;
- a closed pane settles as `present: false`;
- after restart the originals are retained under `local-settled:UUID` and a new
  hire into the directory passes the fence. The fixture has no harness adapter, so
  that hire stops definitely before any native effect and leaves no receipt.

```sh
LOCAL_HIRE_SETTLE_NATIVE_TEST=1 clankie heavy -- pnpm exec vitest run apps/clankie/test/local-hire-settlement-native.integration.test.ts
```
