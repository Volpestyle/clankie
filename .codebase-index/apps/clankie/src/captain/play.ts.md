# apps/clankie/src/captain/play.ts

Asked play, captain side (ADR 0063): submit the
embodiment intent, wait bounded (12s default,
400ms polls) for the runner's answer, and return
the typed `EmbodimentPlayNote` his reply
renders. The captain holds only the ask — no
emulator, process, or credential.

`startPlay()` answers `started` only after the
runner reports running (with resume lineage),
`start_refused` with a sayable reason, or
`pending` past the bound — which he must voice
as "starting it up", never "I'm playing".
`stopPlay()` finds the live session (absent →
`stop_refused: not_playing`), submits a stop,
and answers `stopped` (with any checkpoint) or
`pending`; failed-after-stop still reads as
stopped, honestly checkpoint-free.

`defaultPlayBudget()`: the owner's default is no
cap — he plays until asked to stop;
`CLANKIE_PLAY_MAX_TURNS` /
`CLANKIE_PLAY_MAX_DURATION_MS` restore one.
