# integrations/gba-emulator/scripts/evaluate-live-receipt.ts

`gameplay:evaluate-receipt` — nine-line
wrapper: reads `CLANKIE_GBA_LIVE_RECEIPT_PATH`,
runs `evaluateFireRedLiveReceipt`, prints the
report, exits 1 when it fails. Re-verifies
existing evidence without reopening ROM or
savestate bytes.
