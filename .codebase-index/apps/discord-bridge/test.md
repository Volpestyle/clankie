# apps/discord-bridge/test

Vitest suites for the bridge, all offline —
Discord REST and realtime sockets are injected
fakes; no network. Notable pattern:
subcommand-authority.test.ts asserts authority
tiers against the source text of index.ts,
because the inline per-case gates cannot be
imported without logging in.

- attachment-resolver.test.ts — hash binding and
  symlink-escape refusal
- authority.test.ts — ambient/user-id bindings
  and voice join policy fallbacks
- bot-presence-runtime.test.ts — REST executor,
  activity invite lifecycle, phase fencing
- clankvox-ipc.test.ts — golden fixtures, strict
  schemas, framing faults, signal metadata
- commands.test.ts — the /clankie namespace shape
- live-proof.test.ts — text, person-memory, and
  voice proof evaluators
- presence-runtime-module.test.ts — broker-only
  credential loading, channel allowlists
- readiness.test.ts — full pass and fail-closed
  reports without leaking names/secrets
- subcommand-authority.test.ts — source-asserted
  tier per dispatch case
- voice-composition.test.ts — env parsing,
  volition verdict, receipts, idle auto-leave,
  disclosure wording
- voice-intent.test.ts — gate, decider, retry
  window, deterministic execution, end-to-end
  asked joins (the largest suite)
- voice-readiness.test.ts — readiness checks and
  the wake-transition probe
- voice-realtime-wiring.test.ts — dormant→engaged
  wake and the ElevenLabs path over fake sockets
- fixtures/ — golden ClankVox IPC v1 payloads
