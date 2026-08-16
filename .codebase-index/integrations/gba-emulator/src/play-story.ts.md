# integrations/gba-emulator/src/play-story.ts

Projects a bounded `PlayStoryCard` from the durable
free-play journal for captain and voice consumers.
`projectPlayStory` requires a real header, counts
turns, carries the latest objective and bounded
maps, and keeps only the last speak-worthy effects
as moments.

Monologue, notes, button telemetry, and raw JSONL
never enter the card. Caller-supplied live maps
take precedence over the latest summary maps.
