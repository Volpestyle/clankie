# apps/clankie/src/play-execution.ts

`createGbaPlayExecution()` composes one production GBA playthrough: body lock, ROM/core boot, resume/checkpoints, mind loop, activity frames, room hearing/speech, journal, progress and pull sight. Every collaborator is injectable, and the dev free-play script uses the same function.

It resumes the newest compatible checkpoint, banks before rewinds, autosaves, and writes final continuity. The activity plane receives native-resolution PNGs while the model gets the upscaled decision view; `PlaySightProjection` exposes an on-demand capture and bounded journal story. Room utterances feed the interjection queue, narration uses delivery ids, and settled progress/journal/activity reports stay bounded.

Held body, missing environment, absent voice/activity, and unwritable journal each have explicit fail/refuse/degrade semantics; cleanup always detaches sight, saves when possible, releases the body, and reports measured outcome.
