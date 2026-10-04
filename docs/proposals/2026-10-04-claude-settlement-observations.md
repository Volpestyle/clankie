# Claude settlement observations

VUH-1527: this bounded change removes false completion claims from the existing
Claude worker channel. It does not establish exact message-to-turn completion.

A channel transcript receipt can be a queued-command attachment. The forwarded
Stop and StopFailure payloads have a session ID and bounded native text/error,
but no native turn or message identity. A later observed Stop, even after an
idle dispatch, therefore cannot identify which message finished. Hook sequence,
wall-clock time, equal text and counting Stops are not substitutes for that
missing native correlation.

Scope decision, 2026-10-04: every accepted Claude channel receipt reports
`state: "queued"`, including an idle pane. Neither that state nor the retained
`deliveryStage: "consumed"` means a model saw the message or began its turn. The
initial adapter `start` result still describes the native TUI starting; it is
separate from a brief starting a model turn. The mailbox and wire APIs stay the
same.

The existing bounded hook log now writes a dispatch boundary before handing a
brief or follow-up to the mailbox. A save failure prevents the handoff. The
boundary is retained through newly attached controls and service restarts; idle,
Stop, SessionStart and owner prompts cannot clear it. The log records its own
observation order only. It adds no queue, transcript mirror, delivery retry,
transport, tool authority or account configuration.

Claude settlement returns an explicit unconfirmed observation, with authentic
eligible Stop/StopFailure data when available. It never synthesizes a successful
turn from idle or uses a pre-dispatch Stop as a new message's completion. The
watcher still wakes the original conversation once and quotes uncorrelated Stop
text as data. That wake is not acceptance of queued work; the lead must inspect
the worker's thread and evidence. The ordinary blocked, released and missing-seat
outcomes remain distinct, and caller cancellation aborts a held status wait.

Missing, unreadable and legacy log data cannot establish a known-empty dispatch
history. In particular, the current native hook payload does not distinguish a
freshly born manual session from a resumed session with older queued work. A
first-seen manual watch therefore also reports an unconfirmed observation while
preserving its authentic Stop/StopFailure. There is no fixture-only or inferred
known-empty state. A sequence watermark rejects older observations; it is not
native turn correlation.

The focused causal checks cover stale and absent Stops, a busy turn stopping
after a queued follow-up, a fast Stop during initial delivery, reattachment and
restart, unknown state, persistence failure before either handoff, overlapping
dispatches, owner prompts, native failures, cancellation, lost status and changed
session/pane/terminal bindings. They use the production adapter/log/watch with
fake native dependencies, not model calls. Live remote delivery, native turn
correlation and owner PC acceptance remain unverified; the issue stays open.
