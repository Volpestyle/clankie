# ADR 0030: Tracker-attention delivery and response authority

Status: accepted (VUH-846).

## Context

Human-attention delivery crosses three failure boundaries: concurrent control-plane
processes, provider writes that may succeed before local completion is recorded,
and ambient tracker events that may mention an approval without identifying the
request they answer. Eve channel context is caller-supplied and cannot become
doctrine merely because a field is named `trusted`.

## Decision

The control plane reserves each request on its real mission event stream with an
atomic expected-revision append. The claim records a unique owner and bounded
lease. Contenders wait for the active owner; after expiry a new owner may resume
with the same per-action provider idempotency tokens. Completion uses a stable
request event ID. Stores without compare-and-append fail closed.

Provider bindings remain configuration, while provider execution is concrete.
`createLinearAttentionRuntime` maps semantic roles to an opaque principal and
performs the default assignment, attention-label, and direct-mention comment
through a credential-owning client. The Linear control-plane process requires a
companion attention runtime whenever its agent runtime and human-attention
ceremony are enabled.

Responses arrive either as a complete typed `HumanAttentionResponse` embedded in
a verified agent-session event or as the exact response command emitted by the
Linear adapter and authored by the provider identity bound to the target role.
Free-form approval prose is never interpreted. Event mission, doctrine hash,
envelope correlation, request ID, response correlation, tracker reference,
workspace, issue, and time must match the stored pending request. The HTTP caller
supplies only the pending request ID and verified event ID.

The control plane signs the compiled captain ceremony projection with
`CLANKIE_CAPTAIN_TOKEN`. Eve verifies the HMAC before rendering dynamic
instructions; unsigned or modified channel/client context is advisory only.

## Alternatives considered

1. Process-local mutex only — rejected because restart and multi-process races
   execute duplicate provider writes.
2. Stable provider token without claim ownership — rejected because it is retry
   mitigation, not truthful single-flight coordination.
3. Partial decision fields on an event — rejected because one approval can be
   replayed against another pending request.
4. Trusting Eve `clientContext` by convention — rejected because callers create it.

## Consequences

- Crash recovery is at-least-once internally and externally idempotent when the
  provider honors the mandatory token.
- A crashed owner delays retry until lease expiry instead of racing immediately.
- Linear identities, labels, and mention syntax stay out of protocol and doctrine.
- Missing provider bindings, credentials, signatures, or durable stores are
  explicit unavailable/unsupported outcomes rather than claimed delivery.
