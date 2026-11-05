# Watch question native proof

Run explicitly from a checkout with these fixture files tracked:

```sh
clankie heavy -- node scripts/manual/watch-worker-questions.mjs
```

The runner archives tracked working files only, builds an owned Linux image and
runs it with networking disabled. It mounts only its new evidence directory.
Claude Code 2.1.318 and pinned Herdr start real interactive worker TUIs through
`HerdrWatchStore.spawnSeat` and the production Claude adapter. A loopback
Anthropic-protocol fixture emits Read, then AskUserQuestion, then records Claude's
actual tool result. No real account or paid model is used. The account budget and
managed consent are synthetic fixture state; they attest no real subscription.
Claude's live channel is unavailable with this fixture API key; this proves the
separate synchronous native hook, its stdout acknowledgment and tool consumption.

Both statechart steps use the production `connectWorkerQuestions` wiring, real
settings, ask persistence, owner credential broker and HTTP routes. One question
arrives after Watch starts. The other reaches a real Pi agent session backed by
an in-memory deterministic model; its answer tool is held while Watch starts.
That original lead answer is refused, the ask moves to the feed, and the owner
answers while Watch remains on. Each native question is emitted once, the owner
receipt reconciles without a second answer, and the local provider must observe
the exact native tool result containing React. Completion hooks are awaited
before tearing down the fixture's Herdr namespace.

The canonical Linux process proof requires the initial PID namespace, so the
owned container uses `--pid host`, as the existing Linux native-fleet proof does.
The kernel census and socket-owner checks stay enabled. The nested PID namespace
is a refusal, not an alternative admission path. No real PC, Mac pane, Discord,
provider credential or installed Clankie service is used or changed.

Evidence is printed under `.local/watch-worker-UUID/`: native hire receipts,
route transitions, original lead refusal, per-scenario results and the final
`result.json`. The ordinary integration test covers the real captain wiring,
owner API/CLI, revocation, machine ceilings, stale cards and the lead-seat refusal
without requiring a native installation on CI.
