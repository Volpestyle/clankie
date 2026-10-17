# VUH-2349: self-hosted browser CORS

Issue: https://linear.app/vuhlp/issue/VUH-2349
Decision: [ADR 0274](../../adr/0274-self-hosted-browser-access-uses-exact-origins.md).

The owner opts in using `clankie http allow-origins ORIGIN...`, which replaces
an initially empty list through the revision-checked owner API. Core and relay
read the same settings for each browser request. Origins are exact serialized
HTTP(S) origins with no wildcard, path, credentials or trailing slash. The LAN
device doorway admits OPTIONS only for already exposed device operations.

## Real Chrome result

A fresh headless Chrome 155.0.8059.40 context, with normal Playwright defaults
and no web-security or certificate bypass flags, exercised isolated production
core, device doorway and relay HTTP paths. All listeners used loopback port 0;
owner/device credentials and state were fixture-only and removed afterward.

| Browser action                                    | Result                                                    |
| ------------------------------------------------- | --------------------------------------------------------- |
| Refused page tries JSON pairing redemption        | Browser TypeError; OPTIONS observed, zero redemption POST |
| Allowed page redeems the same code                | 200                                                       |
| Allowed page accepts grants and completes         | 200                                                       |
| Reuses the consumed code                          | 409                                                       |
| Uses signed device token through relay            | 200                                                       |
| Reads relay owner settings without authentication | 401, readable by the allowed page                         |

The observed OPTIONS requests establish that Chrome's own CORS checks ran.
This is a transport proof, not a capture of the full browser app. HTTPS mixed
content and non-loopback local-network permissions were not exercised. No
installed service settings, shared runtime or PC lanes were changed.

## Integration and checks

The real TCP integration covers allowed/refused origins, preflight methods and
headers, absent credentialed CORS, saved settings reload/revocation, corrupt
settings refusal, owner authorization, revision conflicts, native no-Origin
access, single-use pairing through the LAN doorway and signed-device relay
access. The focused CORS, pairing and direct-pairing suites passed 39/39.

The initial fixture used an unsupported `web` platform value; it now uses the
existing `unknown` value without changing the pairing protocol. A fixture-only
server union type was corrected after the focused compiler caught it. The
first manual browser attempt failed in the script's transpiled name helper;
the corrected script avoids the injected nested-function helper. Both failed
instrument receipts are retained with the successful proof.

The issue records the final root landing gate and checked HEAD/base. Focused
checks and Chrome proof do not substitute for that gate. Raw proof output,
producer source, scripts and check receipts are in the evidence store; see
`evidence.json`.
