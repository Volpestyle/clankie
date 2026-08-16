# packages/discord-presence-core/test/voice-audio.test.ts

PCM conversion suite: 48 kHz stereo downmixed and
downsampled to 16 kHz and 24 kHz mono; canonical
mono WAV header bytes; 24 kHz mono resampled to
48 kHz stereo in memory; and rejection of partial
samples and invalid formats.
