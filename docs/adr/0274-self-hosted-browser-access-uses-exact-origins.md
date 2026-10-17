# ADR 0274: Self-hosted browser access uses exact origins

Status: Accepted (Clankie, 2026-10-17, VUH-2349).

## Context

The web app's self-hosted pairing request is cross-origin. Core and relay did
not implement CORS, and the LAN device doorway rejected OPTIONS, so normal
browser security prevented pairing and authenticated API calls. A native HTTP
client passing those routes did not establish browser access.

## Decision

The owner configures `http.allowedOrigins` through the revision-checked owner
settings API and `clankie http allow-origins ORIGIN...`. This is an explicit
replacement list of up to 32 serialized HTTP(S) origins, including their
non-default port. The default is empty. Paths, trailing slashes, opaque `null`
origins, credentials, patterns and wildcards are rejected. Neither a request's
Host/Origin headers nor an advertised relay address adds an origin to settings.

Core and relay apply one policy to `/v1`, `/v1/*`, `/operator/v1` and
`/operator/v1/*`, reading current settings
for each browser request. An allowed Origin receives that exact value in
`Access-Control-Allow-Origin`; a refused Origin is rejected before a handler
can consume pairing state or perform a write. Responses vary on Origin.
Unreadable policy fails closed. Native requests without Origin retain their
existing routing and authentication.

Preflight OPTIONS needs an allowed Origin, a supported requested method, and
only the explicit application request headers. It returns an empty 204 with
the requested method/headers and a five-minute preflight cache lifetime; Vary
also names the requested method and headers. Invalid preflights are rejected.
No preflight invokes an authenticated route or consumes a pairing capability.
The LAN device doorway forwards a preflight only when its requested operation
already passes the doorway's existing method/path allowlist. It forwards the
original OPTIONS request, never the requested operation.

There is no wildcard allowance and no `Access-Control-Allow-Credentials`.
Explicit bearer headers still require their ordinary authentication. Pairing
offers, one-time redemption, grant acceptance, session signing and revocation
remain host-enforced. CORS does not establish native-loopback provenance or
grant operator, captain, device or machine authority. Browser mixed-content
and local-network permission checks continue to apply.

The policy follows the [Fetch CORS protocol](https://fetch.spec.whatwg.org/#http-cors-protocol).
The hosted gateway's own browser policy stays in its private operations repo;
this decision covers public self-hosted core, its device doorway and relay.

## Verification

Real TCP integration exercises the saved settings through owner CLI/API,
allowed/refused/preflight requests on both servers, and pairing through the
LAN doorway followed by signed-device relay access. It checks exact origins,
preflight method/header rejection, policy revocation/unavailability, unchanged
401 authentication and single-use pairing. Browser proof and landing receipts
are linked on VUH-2349; an HTTP-only check is not called a Chrome proof.

## Amendment: Work uses the operator transport (2026-10-17, VUH-2365)

Pairing alone did not prove browser app access: Work also sends authenticated
requests through `/operator/v1/dispatch` and the operator tail transport. The
original `/v1`-only policy left these requests without a preflight response or
CORS headers. Both API namespaces now use the same exact-origin policy before
routing and authentication. `/v1/huddles` remains covered by that policy. This
also explicitly permits the app’s `Cache-Control: no-store` request header;
the original header list caused huddles and body-lease preflight failures. It
adds no authentication bypass or authority; browser requests still need their
normal device grants. Preflights and foreign-origin requests never dispatch an
operator action. Real relay TCP regression coverage and normal-Chrome Work
load evidence are recorded on VUH-2365.
