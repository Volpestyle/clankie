# Remote relay

Two-plane relay for remote Apple clients:

- `control`: low-volume, priority semantic commands and mission events.
- `terminal`: high-volume terminal snapshots, deltas, input, and resize messages.

The included server is deliberately a **local development relay**. It binds to loopback and uses a shared development token. A production implementation must add device-key pairing, short-lived session credentials, per-device scopes, replay protection, durable runner presence, rate limits, TLS, revocation, and end-to-end terminal encryption where practical.

The runner makes the outbound connection. Never expose a local PTY or Herdr socket directly to the public internet.

## Linear agent-session webhook boundary

The Linear webhook components are exported from `src/linear-webhook.ts`:

- `LinearWebhookIngress` verifies exact raw request bytes and produces a bounded envelope.
- `RetainedLinearWebhookQueue` provides delivery-ID dedupe, bounded backpressure, retention, retry, and an outbound-dial transport contract.
- `LinearWebhookLocalBridge` dials that transport and independently verifies the original bytes before emitting a typed agent-session event.

The ingress keeps the webhook signing secret but no Linear OAuth credential. The local bridge opens the connection; the hosted side never opens a listener on the local machine. See [`../../docs/linear-agent-webhook-ingress.md`](../../docs/linear-agent-webhook-ingress.md) for the trust boundary, response behavior, dev tunnel, and production limits.
