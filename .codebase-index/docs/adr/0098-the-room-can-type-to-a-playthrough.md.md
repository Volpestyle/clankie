# docs/adr/0098-the-room-can-type-to-a-playthrough.md

Admitted guild-channel text is pushed to attached
play possessors through ADR 0064's existing
`utterance` message, so a room can steer a live
playthrough without voice-consent setup. No new
transport, allowlist, capability, or retention is
introduced.

The line is an untrusted interjection the player
may ignore, not an order. DMs stay out, long text
is truncated to the seam bound, and the existing
queue cap prevents stale channel backlog.
