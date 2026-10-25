# VUH-2811: voice provider readiness before a call

Issue: https://linear.app/vuhlp/issue/VUH-2811

On 2026-10-25, the source checkout's `doctorCommand` read this Mac's brokered
OpenAI API credential and opened the production transcription listener without
joining Discord, sending audio, committing input or requesting a response.
It reported `refused` / `credit_balance_exhausted` at `13:21:14.910Z`, expiring at
`13:26:14.910Z`. A second doctor read returned the identical timestamp with
`cached: true`. The headline named the provider failure despite twelve
unrelated disconnected seat bridges. Only sanitized readiness fields and bridge
states were retained; no key, transcript, identity or provider message was captured.

The installed service was not updated or restarted. This proves the source
checkout's doctor handler with the real provider, not a deployed runtime or a
successful call. Listener admission remains narrower than conversation or speech
output readiness. No money/account decision was made.

## Verification

- `clankie heavy -- pnpm exec vitest run packages/discord-presence-core/test/voice-provider-readiness.integration.test.ts apps/tui/test/install-doctor.test.ts apps/clankie/test/discord-room-voice.test.ts`: **34/34 passed**, three files.
- The provider integration uses the production realtime WebSocket port against a
  loopback server replaying the exact VUH-2728 `insufficient_quota` /
  `credit_balance_exhausted` error. The real status projection, HTTP, protocol
  client and `clankie discord call` return the refusal while idle. No join route
  is exposed. Repeated/concurrent readers open one provider socket; expiry permits
  one refresh; unavailable cache storage opens none; unconfirmed providers close
  at the five-second deadline. The sole outgoing frame is `session.update`.
- Red controls restored the original doctor summary and original production
  voice-status projection, separately. Both fail their corresponding assertions:
  old headline shows the unrelated disconnected seat; old call status omits
  `providerReadiness`. Source files were restored in `finally` before green checks.
- `clankie heavy -- pnpm --filter @clankie/tui typecheck`: passed all source and
  test shards during implementation. The root landing gate remains the final check.

`verification.json` is stored through the evidence store; `evidence.json` records
its immutable link and checksum. It includes sanitized live observations, real
provider-fixture results, baseline red output and the relevant source digests.
