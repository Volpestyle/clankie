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

## Adoption proof

The second case restores the live Sera hire (receipt `5e29a0d5…`, allocation
`1659d85f…`, pending owner) and the trusted-by-hand Lumi hire (allocation
`3e5ae683…`, pending owner, no receipt) from `fixtures/hire-receipts/local-unconfirmed-hires.json`.
Each pane runs a real native executable compiled as `claude`, with a reported
Claude session and real kernel process proof. `adopt/results.json` retains the
results:

- an idle-shell pane refuses (nothing to adopt);
- before adoption, `nativeOwner` refuses both seats as the live `message_seat` did;
- a non-operator conversation's adopt refuses;
- adopting by receipt UUID and by allocation UUID binds each occupant to the
  hiring conversation and confirms its allocation; the receipt is archived as
  `adopted` with no delivery claim;
- after a restart, repeating adopt reads the retained adoption.

The proof needs the native process helper (`pnpm fleet-proof:build`).

```sh
LOCAL_HIRE_SETTLE_NATIVE_TEST=1 clankie heavy -- pnpm exec vitest run apps/clankie/test/local-hire-settlement-native.integration.test.ts
```
