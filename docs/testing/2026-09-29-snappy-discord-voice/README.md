# Snappy Discord voice — 2026-09-29

Work: [VUH-1446](https://linear.app/vuhlp/issue/VUH-1446/make-discord-voice-brief-and-absorb-conversation-bursts).

James reported long voice replies (median 125 characters, maximum 374, playback
around 15 seconds) and repeated requests during silent handoffs in the
2026-09-29 02:40–03:55Z calls. Those are the supplied live baseline, not
measurements of this implementation. No service restart or live voice join
was performed for this change; private transcripts are not copied here.

The voice briefing now describes a friend in a call, usually one short sentence,
and brief handoff gists with details available in text. OpenAI realtime output
has a session token limit (160 for audio, 80 for externally spoken text); every
Discord mouth also has a six-second PCM ceiling. The provider setting follows
the [OpenAI realtime reference](https://platform.openai.com/docs/api-reference/realtime).

## Offline proof

[Focused test output](focused-tests.txt): 214 tests across five files. The
[full check summary](check-summary.txt) records `pnpm check` and native checks.

| Behavior                           | Evidence                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Burst produces one audible answer  | Session-opening coalescing, guarded provider queues for OpenAI/xAI, and a three-utterance burst through production realtime plus both ElevenLabs compositions |
| Unheard replies go stale           | Generated PCM is zeroed; queued requests and playback are dropped; Vox-buffered audio is stopped before its start event                                       |
| Repeated ask joins existing work   | Normalized repeats and model-selected paraphrase joins submit once; another speaker cannot join that handoff; changed requests still refine                   |
| Slow work stays conversational     | One acknowledgment opportunity after 1.2 seconds, canceled for fast/finished work or quiet; result delivers once                                              |
| Long replies are bounded           | Both OpenAI output modes inherit their token limit; 25 seconds of synthetic PCM yields six seconds, paced into Vox; late PCM retains its old response slot    |
| Stop is immediate locally          | Soft “Can you stop talking?” sends Vox stop synchronously on the final transcript, drops queued room speech, and retains late handoff results silently        |
| Reconnection preserves attribution | Buffered speech drains after provider loss; a replacement conversation owns its own subsequent audio                                                          |
| Text remains thorough              | Only voice briefing/surface instructions changed; the voice endpoint test verifies their composition                                                          |

Tests use synthetic speech, sockets, timers, HTTP, and Vox media. They prove
scheduling, attribution, token settings, audio bounds, and stop dispatch; they
do not measure live provider quality or acoustic latency.

Reproduce the focused run:

```sh
pnpm exec vitest run packages/discord-presence-core/test/voice-session.test.ts packages/discord-presence-core/test/realtime-session.test.ts packages/discord-presence-core/test/external-voice.test.ts apps/clankie/test/app-smoke.test.ts apps/discord-bridge/test/voice-realtime-wiring.test.ts
pnpm check
```

## Live activation remains with James

Judge whether replies sound like a friend rather than an assistant, whether
handoff gists and the one status beat feel natural, whether paraphrased repeat
asks select the existing handoff, and the elapsed speech-to-stop latency. Stop
is synchronous after the final transcript; transcription latency still exists.
The six-second ceiling can clip a runaway sentence and needs live taste review.
The issue stays in review until this call; no push or activation is part of the
implementation handoff.

Decisions: [ADR 0057](../../adr/0057-realtime-voice-with-captain-handoff.md) and
[ADR 0091](../../adr/0091-a-mid-turn-message-steers-the-turn.md).
