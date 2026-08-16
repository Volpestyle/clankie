# apps/clankie/test/operator-conversation-context.test.ts

Exercises operator-conversation context events through the file-backed store. It verifies context occupancy streams and persists into conversation metadata, then confirms stale expected revisions return a typed `revision_conflict` instead of running another turn.
