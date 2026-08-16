# integrations/gba-emulator/src/free-play-journal.ts

The durable trail of a playthrough: one
append-only JSONL per run — header, every
validated turn as it settles, then a summary
with progress/volition/coherence — so a run a
crash interrupts still left its record.
Deliberately a sibling of the runtime's
session record (which rolls under retention),
not a replacement.

`openFreePlayJournal` names the file
`<stamp>-<runId>.jsonl` under the journal root
(`defaultGbaPlayJournalDir`:
`~/.local/state/clankie/gba-play/` or
`CLANKIE_GBA_PLAY_JOURNAL_DIR`), mode 0600.
Opening throws on failure; once play runs,
appends report to `onError` instead — a full
disk must cost the record, never the
playthrough. `parseFreePlayJournal` re-parses
a file, throwing on corrupt lines (a lying
record is worse than none). Zod schemas for
header/turn/summary lines are exported.
