# Native Pi fleet-MCP consumer

VUH-1582: the prepared native Pi extension consumes the existing fleet MCP
bridge, independently of the captain's patched Pi SDK. It adds no authority,
provider catalog, account registry or operator fallback.

Integration fixtures use the installed, capability-checked Pi 0.87.1 SDK with an
isolated native profile and a real standard-MCP stdio subprocess. No prompt,
live provider turn, credential refresh, owner setting change or hire is made.
The release asset is bundled using the same helper as the release builder and
loaded outside the checkout, including its MCP dependencies and dependency
inventory metadata.

Coverage exercises native schema validation, paginated discovery, instructions,
text/images and structured uncertain receipts, native error classification for a
per-call refusal, catalog replacement and withdrawal, disabled tools, project
trust, pre-dispatch cancellation, original controller refusal, in-flight
cancellation, session replacement, RPC exclusion and MCP process loss without
reconnect or replay. The MCP fixture's refusal stands in for the authoritative
server's changing grant; existing worker-MCP integration tests cover that server.

Run the native boundary fixture with:

```sh
clankie heavy -- pnpm exec vitest run apps/clankie/test/pi-worker-fleet.integration.test.ts
```

The fixture skips when Pi is absent or the platform is unsupported. On this Mac
it uses the installed pinned capability and must pass without skips. Covering
control, prepared-hire and authoritative worker-MCP suites run separately,
followed by `clankie heavy -- pnpm check:landing`.

Verification results are recorded with the landing evidence on
[VUH-1582](https://linear.app/vuhlp/issue/VUH-1582/hire-pi-workers-through-native-delivery).

Remaining acceptance: owner Pi opt-in and native profile refresh; a live Mac
hire and native brief/follow-up/interrupt/report, including a Discord-origin
completion; live hosted native/billing evidence; and the public landing-page Pi
listing after the live acceptance is met. VUH-1582 stays In Progress.
