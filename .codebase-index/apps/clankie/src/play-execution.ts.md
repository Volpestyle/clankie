# apps/clankie/src/play-execution.ts

The production `PlayExecution`: one whole GBA
playthrough — body lock, boot, checkpoints,
frame publishing, voice, journal — as a single
injected function owned by the play host. The
dev script drives the same composition.

`createGbaPlayExecution(options)` returns the
execution; every collaborator is injectable for
tests (mind, voice agent, boot, voice seam,
interjections, activity write port).

Degradation rules (ADR 0063): held body lock →
typed `body_held` refusal before any boot cost;
missing ROM/fixture/model →
`environment_unavailable`; missing activity
producer → counted dropped frames; missing voice
seam → silent but watchable (ADR 0067);
unwritable journal → unrecorded playthrough
(ADR 0068). Each case logs which.

Flow:

- Resume from the newest compatible checkpoint
  (ROM + core sha gates, ADR 0060), restoring
  the continuity notes/objective minted with it;
  corrupt candidates are skipped with a log.
- Frames: paced per-action PNG publishes to the
  brokered activity sink; per-turn overlay
  (objective/intent/monologue/effect).
- Voice: room utterances feed the same
  `InterjectionQueue` as stdin; outbound,
  `reportToRoom()` sends the turn's effect line
  (+ goal), never a finished sentence (ADR
  0074), and only on turns `speakWanted`
  gated — one volition judgment, not two.
- Checkpoints: his own checkpoint tools
  (list/load/restart) bank the present before
  any rewind; autosave every
  `CLANKIE_PLAY_AUTOSAVE_TURNS` (default 50);
  a final "asked-play" checkpoint carries the
  last turn's continuity.
- Journal + latest-only activity snapshots per
  settled turn; receipt reports outcome, turns,
  duration, frames published/dropped,
  checkpoint lineage.
