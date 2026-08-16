# packages/possessor-voice/src/client.ts

The possessor side of the seam: dials out to the
bridge's loopback listener with a broker-resolved
bearer.

Exports:

- `createBrokeredPossessorVoiceClient()` —
  resolves the bearer via
  `resolvePossessorVoiceCredential()`; returns
  undefined when the seam was never bootstrapped
  (deny-by-default: no credential, cannot speak).
- `createPossessorVoiceClient(options)` — the
  client proper: `narrate(text, {deliveryId?})`
  (trimmed,
  2 000-char bound, rejects with typed
  `clankie_speech_*` errors — including
  `clankie_speech_unavailable` when the bridge is
  unreachable, refusing rather than queueing),
  `subscribe(listener)` for room utterances,
  `roomListening` (false until the bridge says
  otherwise, reverts to false on disconnect so
  authorship falls back to the possessor's own
  surfaces per ADR 0074), `connected`, `close()`.
- `PossessorVoiceSocket` — structural socket view
  so tests never open a real one.

Reconnects on close with a fixed delay; malformed
or off-contract server messages are ignored; one
throwing subscriber cannot starve the others.
The optional delivery id lets play-journal and
voice receipts share one correlation key.
