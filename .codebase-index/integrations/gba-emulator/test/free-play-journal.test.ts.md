# integrations/gba-emulator/test/free-play-journal.test.ts

Tests the play journal: header + every turn +
summary land as one parseable JSONL file with
per-run filenames, corrupt lines throw on
parse, and append failures route to `onError`
instead of killing the playthrough.
