# VUH-2144 fresh intent settlement

Fresh intents have a caller-retained UUID distinct from the service's native
receipt UUID. Recovery now resolves either identity without changing the original
key, native ID, fingerprint, remote claim or launch guard. The operator API/CLI
keeps its existing authority; the lead tool may settle only a fresh receipt owned
by its current conversation. Remote leads receive the same tool through their
fleet link. A later, separately authorized hire may use either settled identity
as `afterReceiptId`; the old intent and every retained brief remain fenced.

Checked on macOS with the real isolated Herdr daemon, process census and host
receipt program (no model turn):

```sh
clankie heavy -- env HIRE_RECEIPT_NATIVE_TEST=1 pnpm exec vitest run apps/clankie/test/remote-hire-receipts.integration.test.ts
```

All 17 cases passed, including fresh-ID `not-launched`, mapped `abandoned`, and
unmapped `abandoned-unknown`; wrong-lead refusal; revoked authority after host
recovery; CLI/HTTP settlement; restart retention; late launch refusal; and a
separately new fresh intent after settlement. Existing brief replay checks remain
in `fresh-hire-intent.integration.test.ts`.

The real PC receipt settlement and integration receipts are attached to VUH-2144
when performed. This local host proof alone does not establish the PC receipt's
state or prove a replacement hire. Remote pane close remains VUH-2153; settlement
closes no pane and never sends a brief.
