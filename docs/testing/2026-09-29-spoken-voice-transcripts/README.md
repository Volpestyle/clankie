# Retained spoken wording — 2026-09-29

Work: [VUH-1446](https://linear.app/vuhlp/issue/VUH-1446/make-discord-voice-brief-and-absorb-conversation-bursts).
Decision: [ADR 0121](../../adr/0121-development-voice-transcripts-are-explicit.md).

The 04:58–04:59Z call exposed an observability gap: receipts measured long replies
but retained no generated wording to judge tone. The existing opt-in private
transcript now includes Clankie's reply text and correlated playback outcomes.
This does not reconstruct that earlier call or claim that brevity improved.

## Offline evidence

- 244 focused tests across eight files pass: native OpenAI/xAI transcript wiring,
  both ElevenLabs compositions, private append/paging, legacy inbound records,
  authenticated/disabled API behavior, CLI paging, and TUI identity/outcome labels.
- Session regressions cover clean playback, interruption with late text, stale
  suppression, provider/playback failure, leaving mid-response, the 45-second
  backstop, disabled/unsubscribed logging, and subscriber error isolation.
- Three Swift tests pass, including legacy decoding and assistant identity/cutoff
  labels. The menu bar builds as part of that run.
- `clankie discord transcripts --limit 1` successfully read a bounded existing
  human entry through the running authenticated service. This is read-only CLI
  compatibility evidence, not live assistant logging proof.
- Full repository result is recorded in [check-summary.txt](check-summary.txt).

Reproduce:

```sh
pnpm exec vitest run packages/discord-presence-core/test/voice-session.test.ts packages/discord-presence-core/test/transcript-store.test.ts packages/discord-presence-core/test/realtime-session.test.ts apps/tui/test/voice-transcripts.test.ts apps/tui/test/discord-transcripts-cli.test.ts apps/clankie/test/voice-transcripts.test.ts apps/discord-bridge/test/voice-realtime-wiring.test.ts apps/discord-bridge/test/voice-composition.test.ts
pnpm --filter @clankie/menu-bar test
pnpm check
```

## Limits and activation

No restart, voice join, or push was performed. James activates the updated service
and active Discord body. With the existing logging setting on, a fresh call
should produce assistant entries in the same mode-0600 log and expose them via
`clankie discord transcripts`, `/vt`, and the menu bar. No raw audio is saved.

Generated text after an interruption, failure, suppression, or truncation may
include words never heard. Outcomes, `audioStarted`, `playbackMs`, and
`textComplete` preserve that distinction; exact audible word alignment remains
unknown. Empty provider text leaves no entry, and a process crash cannot promise
a terminal record. Live provider delivery and tone still need a call.
