# apps/vox/src/audio_pipeline.rs

Implements `AudioSendState`, which buffers normalized 48 kHz mono TTS/music PCM, gates short utterances, applies gain envelopes, mixes sources, and produces paced Opus frames. Conversion helpers resample LLM and decoded capture audio, while bounded buffers and selective clear/suppress operations preserve floor semantics.
