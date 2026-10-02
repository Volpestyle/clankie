# Queries that answered real questions

Copy-ready reads against the trails in [the trail map](trail-map.md).

Last N chat messages in a conversation:

```bash
tail -n 40 ~/.clankie/captain/conversations/<id>/events.jsonl | jq -c '{type, role, text}'
```

Per-turn survey vs implementation shape (survives conversation prune):

```bash
jq -c '{runId, lane, outcome, toolCount, firstMutatingTool, mutatingCount, surveyToolCountBeforeFirstMutation}' \
  ~/.clankie/captain/turn-settled.jsonl | tail -n 20
```

What ran a turn and what it cost in reported tokens. Prefer the read surfaces —
`clankie metrics [--run ID] [--limit N]` or `GET /v1/captain/turn-metrics` — which
answer the same rows newest first with `execution` and `usage` explicitly `null`
when unknown:

```bash
clankie metrics --limit 5 | jq -c '.items[] | {runId, outcome, execution, usage}'
```

`execution` is the model/provider/effort that actually executed the turn, not the
current configuration; it is null for turns settled before that capture existed.
`usage.totalTokens` is what the provider reported, summed over `usage.reports`
assistant messages, and is null when nothing was reported — never zero. Never read
`contextTokensStart`/`contextTokensEnd` as usage or as a charge: they are context
occupancy, and no cost is recorded anywhere.

Every tool he ran in a room, newest last (`rooms/` and `voice/` hold durable
social or trusted-system lanes; `turns/` holds actor-level privileged
one-shots):

```bash
jq -c 'select(.type=="message" and .message.role=="assistant")
       | {at: .timestamp, tools: [.message.content[] | select(.type=="toolCall") | .name]}
       | select(.tools | length > 0)' \
  ~/.clankie/captain/rooms/*/*.jsonl ~/.clankie/captain/voice/*/*.jsonl \
  ~/.clankie/captain/turns/discord_presence~*/*.jsonl
```

Swap `.name` for the whole block to see arguments, and grep the same files for
`"role":"toolResult"` to see what came back.

What happened tonight, minus presence noise:

```bash
jq -c 'select(.type | startswith("captain.presence") | not) | {type, occurredAt}' ~/.clankie/events.jsonl | tail -n 60
```

Does durable memory contain anything, without printing its contents:

```bash
find ~/.clankie/memory -type f -maxdepth 2 -exec wc -l {} +
```

Is a presence session real or a ghost:

```bash
grep '<session-id-prefix>' ~/.clankie/events.jsonl | tail -n 5 | jq -c '{occurredAt, phase: .data.phase, reason: .data.reason}'
```

Did he speak this stay, and are play reports dropped:

```bash
jq -c 'select(.type == "discord.voice.response" or .type == "discord.voice.play_narration_suppressed" or .type == "discord.voice.left") | {type, at: .occurredAt, stayId: .data.stayId, deliveryId: .data.deliveryId, trigger: .data.trigger, reason: .data.reason, spoken: .data.spokenCount, suppressed: .data.narrationSuppressed, tokens: {in: .data.inputTokens, out: .data.outputTokens}}' ~/.local/state/clankie/discord-live-receipts.jsonl | tail -n 40
```

What did the room and Clankie say in development (private, opt-in):

```bash
clankie discord transcripts --limit 40
```

Raw file inspection keeps output outcomes alongside generated text:

```bash
tail -n 40 ~/.local/state/clankie/discord-voice-transcripts.jsonl | jq -c '{at: .occurredAt, body, guildId, channelId, stayId, deliveryId, role, speakerId, displayName, itemId, playbackId, outcome, textComplete, audioStarted, playbackMs, text}'
```

Where did one voice/music turn stop:

```bash
jq -c --arg id '<delivery-or-call-id>' 'select(.data.deliveryId == $id or .data.callId == $id) | {type, at: .occurredAt, data: .data}' ~/.local/state/clankie/discord-live-receipts.jsonl
```

Checkout-only live proofs (`watch-live-proof`, `publish-live-proof`,
`gameplay:evaluate-journal`, `pnpm discord:voice-readiness`) live in
`verify-clankie`, which is present only in a source checkout.
