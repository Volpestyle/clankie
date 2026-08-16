# apps/vox/docs/audio-pipeline.md

Implemented native Discord voice and music pipeline, including RTP parsing, DAVE decrypt/encrypt, Opus/PCM transforms, pacing, capture, playback, and lifecycle events. It clarifies RTP-size AAD construction and that current Clankie ordinary voice/music does not yet consume this Vox capability.
