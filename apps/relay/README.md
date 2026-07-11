# Remote relay

Two-plane relay for remote Apple clients:

- `control`: low-volume, priority semantic commands and mission events.
- `terminal`: high-volume terminal snapshots, deltas, input, and resize messages.

The included server is deliberately a **local development relay**. It binds to loopback and uses a shared development token. A production implementation must add device-key pairing, short-lived session credentials, per-device scopes, replay protection, durable runner presence, rate limits, TLS, revocation, and end-to-end terminal encryption where practical.

The runner makes the outbound connection. Never expose a local PTY or Herdr socket directly to the public internet.
