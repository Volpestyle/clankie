# ADR 0165: Signed Linear activity enters through the public doorway

Status: accepted. Awareness and conversation routing follow
[ADR 0168](0168-linear-awareness-is-opt-in.md).

## Context

Linear needs a public HTTPS endpoint while the Mac accepts no inbound internet
connections. The existing public doorway routes requests home over the Mac's
outbound WebSocket. The endpoint must answer within Linear's delivery deadline
without waiting for a model turn.

## Decision

`POST /v1/hooks/linear` is a `control` route in the shared gateway allowlist.
The public URL is `https://api.clankie.bot/h/{hostId}/v1/hooks/linear`.
Signature, delivery and event headers cross both hops through the shared
request-header allowlist.

The route verifies HMAC-SHA256 against the exact raw body before parsing it.
It checks the signed `webhookTimestamp` against a 60-second freshness window.
A bounded in-memory set remembers 512 delivery IDs; a restart or eviction can
admit a duplicate. Invalid authenticity answers 401, malformed data answers
400, and authenticated activity that is ignored answers 200 to avoid retries.

The webhook signing secret lives in the credential broker as `linear-webhook`,
separate from the MCP OAuth token. The owner creates or updates the webhook in
Linear's settings and stores its secret through `/connect linear`. The MCP
token is audience-restricted to Linear's MCP resource and is not a webhook
administration credential.

The hook admits data-change envelopes across resource types and persists them
in the inbox. When following is on, model work is queued without awaiting
completion. The follow switch and inbox behavior are defined by
[ADR 0168](0168-linear-awareness-is-opt-in.md). A verified account identity does
not prove a human wrote the activity.

## Alternatives

Polling would add latency and repeated reads. The provider's native webhook
uses the public transport already in place. Opening an inbound Mac port adds
an unnecessary second access path.

## References

- [Linear webhooks](https://linear.app/developers/webhooks)
- [Linear OAuth](https://linear.app/developers/oauth-2-0-authentication)
