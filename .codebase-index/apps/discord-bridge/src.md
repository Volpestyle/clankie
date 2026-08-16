# apps/discord-bridge/src

The bridge process and its offline-testable
composition modules. index.ts is the only file
with process-global startup; everything else is
side-effect-free wiring or a small CLI.

- index.ts — startup guards, gateway client,
  slash dispatch, ingress/voice composition
- commands.ts — the single `/clankie` slash
  namespace and its subcommands
- authority.ts — ambient and voice-presence
  authority tiers (ADR 0050)
- text.ts — Discord text sanitizer
- attachment-resolver.ts — hash-bound filesystem
  attachment resolver
- bot-presence-runtime.ts — REST executor for
  the presence action catalog (ADR 0024 P1)
- presence-runtime-module.ts — service load
  target wrapping the runtime behind broker
  grants
- voice-composition.ts — realtime env parsing,
  realtime/TTS ports, volition decider, idle
  auto-leave, disclosure text (ADR 0057/0070)
- voice-intent.ts — asked voice presence: gate,
  intent read, retry window, execution (ADR 0062)
- readiness.ts / voice-readiness.ts — fail-closed
  live readiness checks (voice adds a real
  dormant→engaged wake probe)
- live-proof.ts — receipt-log evaluators for the
  text, person-memory, and voice proof gates
- *-cli.ts — thin stdout wrappers for the above
  (readiness, live-proof, person-memory,
  voice-readiness, voice-live-proof)

Flow: gateway events → presence phase publication
to the service; messages → DiscordTextIngress
(with a voice-presence ask decided first, so the
same captain turn carries the outcome note);
interactions → the `/clankie` switch, each case
gating inline on its authority tier. All evidence
lands as content-free JSONL receipts.
