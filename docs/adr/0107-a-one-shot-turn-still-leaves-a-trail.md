# ADR 0107: A one-shot turn still leaves a trail

Status: accepted (James, 2026-08-16). Applies to bounded Discord text turns and
privileged one-shots.

## Context

Discord text turns, and every privileged turn under
[ADR 0105](0105-voice-is-as-capable-as-the-room-it-is-in.md), run on a one-shot
pi session so nothing carries forward to the next speaker. Those sessions were
in-memory, so the tree died with the turn.

That left tool calls untraceable on the text plane. The lane log
([ADR 0083](0083-every-room-he-thinks-in-is-watchable.md)) records what he heard
and said, never what he ran; the Discord receipts are content-free by schema and
carry no text-plane tool vocabulary at all. So the turns with the most reach —
an allowlisted actor granting him a shell and `herdr` — were the least
inspectable ones in the service. Voice was already covered from both sides: a
durable channel tree holds the `ask_clankie` handoff, and
`discord.voice.realtime_tool` receipts name the realtime model's own calls.

## Decision

One-shot is a context property, not a storage property. Those turns now run on
`SessionManager.create` against
`~/.clankie/captain/turns/<lane>~<encoded-target>/`, one tree per turn: the
session still starts empty and still dies at the end of the turn, but the tree
it wrote stays on disk.

The directory is named with the same `laneKey` the lane log spends on its
`<key>.jsonl`, so a room's two trails carry one name. The format is the pi tree
already written for operator conversations and voice channels, so existing
readers need no new parser.

Pi holds the file back until an assistant message arrives, so a turn that
aborted or timed out before he answered leaves no tree — absence of a file is
itself evidence about the turn.

## Consequences

- What he ran in a Discord room is readable afterwards, with arguments and
  results, not just a count of replies.
- A privileged turn's shell commands are recorded. This is the only place they
  are; the receipts above them stay content-free.
- Untrusted channel bodies now reach disk under `~/.clankie/captain/`, at the
  same sensitivity as the operator conversations and voice trees already stored
  there. The content-free fence still governs the receipts, which is where it
  was ever load-bearing.
- One file per turn, unbounded. Rooms are separate directories, so pruning by
  modification time is per-room when it is needed; nothing prunes today.
- Sessions still do not continue. Two turns in a room share a directory and
  share nothing else.
