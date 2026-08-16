# docs/adr/0091-a-mid-turn-message-steers-the-turn.md

Durable Discord lanes treat a message arriving
during an active pi run as steering, not a second
queued reply. `runDurableTurn` lets the first
caller own the merged final response; absorbed
callers wait for settlement and return silent, so
the room hears exactly one answer.

The lane records an in-flight settlement promise
to close pi's pre-streaming race window. Only the
run owner resets media capture, and the lane log
records two `heard` entries with one `said`.
