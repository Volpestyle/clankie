# ADR 0177: Discord delivery survives a bridge restart

## Decision

The official bot keeps a mode-0600 SQLite delivery journal beside its receipt
log (`discord-text-inbox.sqlite`). Discord remains the source of channel
history. The journal holds message ids, scan cursors, channel activity counters, and the exact accepted
captain request/result until delivery is acknowledged. Completed entries are retained for seven days
before pruning behind the scan cursor. It is not a second
conversation or a new agent.

```mermaid
flowchart TD
  Gateway[Gateway message] --> Pending[Durable pending delivery]
  History[Startup / reconnect / periodic history scan] --> Pending
  Pending --> Request[Persist exact captain request]
  Request --> Captain[Existing channel conversation]
  Captain --> Result[Persist result]
  Result --> Reply[Post reply with stable Discord nonce]
  Reply --> Ack[Record Discord acknowledgement]
  Ack --> Prune[Prune completed entries behind scan cursor]
  History -->|Reply already exists| Ack
```

On startup, reconnect, and once a minute, the bridge scans admitted guild text
channels, active threads, and previously known DM channels after their saved
cursors. History uses the same admission policy as live ingress: under
`addressed`, mentions, configured names, replies to the bot, and unaddressed
follow-ups in channels he has spoken in enter the journal; `all` admits all
human messages in permitted rooms. Guild/channel/DM trust checks still apply.
The channel activity map and messages-since-reply counters persist without
message bodies, including the existing tracked-channel cap and eviction order.
On first discovery or upgrade, one page before the cursor can establish activity
from his own messages; replies in scanned pages also establish activity before
subsequent messages are considered. Older participation outside that bootstrap
page cannot be inferred. Scan cursors do not rewind on upgrade.

Recovered messages re-enter ordinary ingress with `catchingUp`, so they are
read even when the live attention window has elapsed. Interrupted accepted turns
remain pending. Current ingress and presence authority still gate every recovered
delivery. Live messages retain the existing attention and reply policy.

The first installation scans the preceding 24 hours and imports unfinished
accepted deliveries from the existing receipts within that window. Recorded
replies and deliberate silence are acknowledged; historical
failures are reconsidered only when the history scan admits the message.
Subsequent downtime uses persistent cursors rather than a time cutoff.
Legacy absorbed receipts without an owning-delivery link are reconsidered
independently, rather than treated as proof that a reply reached Discord.

A retry reuses the exact accepted request, so a surviving captain can return
or join its existing delivery-id result. A result already saved in the journal
never runs the model again. A failed model result is retryable in both ingress
and the service. A deliberate silent result is completion, not failure.

The journal saves the outgoing reply before sending it. Discord history
reconciles that exact content when its acknowledgement was lost; a progress
update or tool-status card referencing the same question cannot acknowledge
the final answer. A stable
nonce also deduplicates immediate retry races using Discord's
[Create Message nonce contract](https://docs.discord.com/developers/resources/message#create-message).
The nonce window is only a few minutes; history reconciliation provides the
longer-lived check.

## Trade-offs

An in-memory queue or graceful shutdown alone cannot recover a killed process
or messages sent while offline. Replaying all server chatter creates unwanted
replies. The durable journal plus policy-gated history scan covers those failures
without changing the captain's conversation model or creating an inbox UI.

This is at-least-once execution, not exactly-once tool execution: if both the
bridge and captain die before a result is saved, retrying may repeat work.
An absorbed message names its owning reply delivery. It stays pending until
that combined answer is acknowledged. If the combined answer was never saved
before a restart, the absorbed message is reconsidered as an independent turn
with a stable recovery id; a new answer to the first message cannot silently
acknowledge a question that was folded into the lost run.

Known DM channels and active threads are recoverable; the bot cannot discover
an unknown DM through guild history, and an undiscovered archived thread is
outside the active-thread scan. The lab user-session transport retains its
existing behavior.

## Reconnect diagnosis (VUH-1447)

The September 29 outage was a sleeping host: macOS sleep covered the missed
message, and 12 of 14 reconnects between 15:00Z and 19:00Z occurred within
four seconds of a DarkWake; the other two followed wakes by 33–36 seconds.
Vox runs in a separate process; nearby audio tick slippage does not establish
a Node event-loop bug. This is not evidence of benign Discord-side churn.
See the [content-free investigation and checks](../testing/2026-09-29-discord-reconnect-recovery.md).

The bridge does not override system/lid sleep. Persistent catch-up handles its
message-delivery consequences when the host resumes. Gateway diagnostics now
record allowlisted heartbeat-ACK failures, Discord reconnect requests, close
codes, invalid sessions, replay counts, and maximum Node event-loop delay at
reconnect. Raw debug packets, URLs, credentials, and message bodies are excluded.
