# Browser Work through the self-hosted relay (VUH-2365)

The real relay TCP regression first returned 405 for an allowed-origin
`OPTIONS /operator/v1/dispatch`. The shared policy only covered `/v1`. Adding
`/operator/v1` fixed dispatch, but the actual browser exposed a second refusal:
huddles and body-lease requests send `Cache-Control: no-store`, absent from the
explicit request-header list. An additional red test reproduced its 400.

The repair applies the existing exact-origin policy to both API namespaces
and explicitly permits `cache-control`. It does not widen the origin list,
add credentialed cookies, or change authentication or device grants. ADR 0274,
the CLI guide and the shipped machine skill describe the scope.

## Evidence

The [manifest](evidence.json) links the private proof bundle and inspected Work
screenshot. The bundle retains both red regressions, intermediate proof-driver
failures, the final asserted browser run, its producer and the frozen app
export's file digests. Raw app output and local state stay out of public Git.

`apps/relay/test/browser-cors.integration.test.ts` exercises real loopback TCP
core and relay servers. It covers dispatch, tail, huddles and project preflight
with the app's authorization/cache-control/content-type headers, exact ACAO,
foreign-origin refusal and unchanged relay 401 responses. Existing cases retain
pairing single use, signed-device authority and policy failure/revocation.

The separate normal-Chrome integration driver starts the real service and relay
entrypoints with one isolated scratch-stack preset, serves the existing
VUH-1969 app export (app revision f2a9741b), seeds a local tracker project and
issue through the owner API, and pairs through the actual UI. Chrome 155 with
normal security displayed `LOCAL-1 Verify browser Work through relay` in Work's
Issues tab. Relay dispatch and huddles returned 200; dispatch/huddles preflights
returned 204 with the exact origin. A different-origin dispatch failed with
TypeError, and the allowed origin had no CORS console errors. All owned browser,
HTTP and child service processes were stopped in teardown.

This is scratch proof, not deployment proof. The empty scratch captain has no
live model: unrelated `lead_chats`/`owner_update_list` calls returned 502. They
are retained rather than presented as a clean whole-app health result. The
original failed driver used a pairing link without its scratch direct origin;
a later driver used the wrong Issues accessibility role. Neither is a product
CORS failure. The intermediate run before adding `cache-control` did load Work
but still failed huddles; only the final green5 run proves both repairs.

Root landing receipts and the final commit are attached to
[VUH-2365](https://linear.app/vuhlp/issue/VUH-2365).
