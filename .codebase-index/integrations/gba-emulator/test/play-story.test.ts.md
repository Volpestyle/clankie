# integrations/gba-emulator/test/play-story.test.ts

Tests the bounded journal-to-story projection.
It verifies that only `speakWanted` effects become
moments, the latest objective and supplied maps
survive, monologue stays absent, and a missing
journal header fails rather than inventing a run.
