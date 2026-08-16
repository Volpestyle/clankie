# apps/clankie/test/browser-host.test.ts

Exercises the browser host against a fake
`agent-browser mcp` speaking real
newline-delimited JSON-RPC over in-memory
streams — the framing is real, the browser is
not. Covers `browserEnabled` defaults (on unless
explicitly falsey), full-catalog-minus-blocklist
projection, bounded text results, blocklisted
calls refused instead of forwarded, and image
blocks parked as sha256-named artifacts on disk
(the screenshot-with-no-pixels fix).
